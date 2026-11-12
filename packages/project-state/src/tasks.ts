import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { stateError } from './errors.js';
import type { ProjectStore, WriteTransaction } from './store.js';

/**
 * Task execution state. The vocabulary matches spec 8.2 exactly; the two extra
 * fields Mona needs are the explicit owner and the recorded step a resumed task
 * continues from.
 */
export type TaskStatus = 'pending' | 'running' | 'verifying' | 'completed' | 'blocked' | 'interrupted' | 'skipped';
export type ExecutionOwner = 'mona_queue' | 'native_workflow';
export type TaskCriterionKind = 'check' | 'human';
export type TaskStepStatus = 'pending' | 'running' | 'done' | 'failed';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'running',
  'verifying',
  'completed',
  'blocked',
  'interrupted',
  'skipped',
];

/**
 * The state machine from spec 8.2. The one extension is completed -> verifying:
 * a later code change can make test evidence stale, and a completed task must
 * not keep claiming verification it no longer has.
 */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['running', 'skipped'],
  running: ['verifying', 'blocked', 'interrupted'],
  verifying: ['completed', 'running', 'blocked', 'interrupted'],
  interrupted: ['running', 'blocked', 'skipped'],
  blocked: ['running', 'skipped'],
  completed: ['verifying'],
  skipped: [],
};

export type TaskStep = {
  id: string;
  taskId: string;
  position: number;
  title: string;
  status: TaskStepStatus;
  detail: string | null;
  updatedAt: string;
};

export type TaskCriterion = {
  id: string;
  taskId: string;
  position: number;
  description: string;
  kind: TaskCriterionKind;
  required: boolean;
  satisfiedAt: string | null;
  satisfiedNote: string | null;
  evidenceId: string | null;
};

export type TaskRequirementRef = {
  requirementId: string;
  criterionId: string | null;
};

export type TaskEvidence = {
  id: string;
  taskId: string;
  criterionId: string | null;
  path: string;
  sha256: string;
  kind: string;
  note: string | null;
  recordedAt: string;
  stale: boolean;
  staleReason: string | null;
};

export type TaskTransitionRecord = {
  id: string;
  taskId: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus;
  reason: string;
  actor: string;
  at: string;
};

export type WorkTask = {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  promptId: string | null;
  description: string;
  executionOwner: ExecutionOwner;
  promptText: string;
  ordinal: number;
  currentStep: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  blockedReason: string | null;
  skippedReason: string | null;
  createdAt: string;
  updatedAt: string;
  steps: TaskStep[];
  criteria: TaskCriterion[];
  requirements: TaskRequirementRef[];
  dependencies: string[];
  dependents: string[];
  evidence: TaskEvidence[];
  transitions: TaskTransitionRecord[];
};

export type TaskStepInput = { title: string; detail?: string | undefined };
export type TaskCriterionInput = {
  description: string;
  kind?: TaskCriterionKind | undefined;
  required?: boolean | undefined;
};
export type TaskRequirementInput = { requirementId: string; criterionId?: string | undefined };

export type CreateTaskInput = {
  projectId: string;
  title: string;
  description?: string;
  promptText?: string;
  promptId?: string | null;
  owner: ExecutionOwner;
  ordinal?: number;
  dependsOn?: string[];
  steps?: TaskStepInput[];
  criteria?: TaskCriterionInput[];
  requirements?: TaskRequirementInput[];
};

export type TaskPatch = {
  title?: string;
  description?: string;
  promptText?: string;
  promptId?: string | null;
  owner?: ExecutionOwner;
  ordinal?: number;
  dependsOn?: string[];
  steps?: TaskStepInput[];
  criteria?: TaskCriterionInput[];
  requirements?: TaskRequirementInput[];
};

export type EligibilityCheck = { name: string; ok: boolean; detail: string };

export type TaskEligibility = {
  taskId: string;
  eligible: boolean;
  reason: string;
  checks: EligibilityCheck[];
};

export type TaskBoardEntry = {
  task: WorkTask;
  eligibility: TaskEligibility;
};

export type TaskBoard = {
  projectId: string;
  generatedAt: string;
  tasks: TaskBoardEntry[];
  eligible: string[];
  next: string | null;
};

export type TaskPrompt = {
  text: string;
  sha256: string;
  characters: number;
  truncated: boolean;
  sections: string[];
  /** Mona never injects whole design documents into a task prompt. */
  documentsInjected: 0;
};

export type TaskContextPreview = TaskPrompt & {
  taskId: string;
  title: string;
  notes: string[];
};

export type TaskClaim = {
  task: WorkTask;
  prompt: TaskPrompt;
  actor: string;
  claimedAt: string;
};

export type CheckInput = {
  path: string;
  kind?: string;
  note?: string;
  /** A failing check is recorded as evidence but never satisfies the criterion. */
  passed?: boolean;
  /** Optional observed hash; when present it must match the file on disk. */
  sha256?: string;
};

export type CompletionReport = {
  taskId: string;
  completed: boolean;
  status: TaskStatus;
  gaps: string[];
};

export type QueueRunResult = {
  ran: boolean;
  reason: string;
  taskId: string | null;
  prompt: string | null;
  promptSha256: string | null;
  status: TaskStatus | null;
  completion: CompletionReport | null;
  error: string | null;
};

export type ReconcileReceipt = { taskId: string; fromStatus: TaskStatus; step: string | null; reason: string };

export type RevalidateInput = { path: string; sha256?: string };
export type RevalidateResult = {
  checked: number;
  invalidated: Array<{ taskId: string; evidenceId: string; path: string; reason: string }>;
  reopened: string[];
};

export type TaskRunControl = {
  taskId: string;
  prompt: string;
  beginStep(stepId: string): Promise<void>;
  completeStep(stepId: string, detail?: string): Promise<void>;
  failStep(stepId: string, detail: string): Promise<void>;
  recordCheck(criterionId: string, input: CheckInput): Promise<void>;
};

export type TaskExecutor = (control: TaskRunControl) => Promise<void> | void;

export type TaskServiceOptions = {
  now?: () => Date;
  /** Maximum characters in a task prompt; larger prompts are refused for dispatch. */
  maxPromptChars?: number;
};

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20_000;
const MAX_PROMPT = 100_000;
const MAX_STEPS = 100;
const MAX_CRITERIA = 50;
const MAX_DEPENDENCIES = 200;
const MAX_REQUIREMENTS = 100;
const DEFAULT_MAX_PROMPT_CHARS = 24_000;

const PlanCriterion = z
  .object({
    description: z.string().min(1),
    kind: z.enum(['check', 'human']).optional(),
    required: z.boolean().optional(),
  })
  .strict();

const PlanStep = z.object({ title: z.string().min(1), detail: z.string().optional() }).strict();

const PlanRequirement = z
  .object({ requirement_id: z.string().min(1), criterion_id: z.string().min(1).optional() })
  .strict();

const PlanTask = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    prompt_id: z.string().nullable().optional(),
    prompt_text: z.string().optional(),
    owner: z.enum(['mona_queue', 'native_workflow']),
    ordinal: z.number().int().nonnegative().optional(),
    depends_on: z.array(z.string().min(1)).optional(),
    steps: z.array(PlanStep).optional(),
    acceptance: z.array(PlanCriterion).optional(),
    requirements: z.array(PlanRequirement).optional(),
  })
  .strict();

/** A prompt pack / plan is inert data: importing it creates pending tasks only. */
export const TaskPlan = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal('mona.task-plan'),
    project_id: z.string().min(1),
    name: z.string().min(1).optional(),
    tasks: z.array(PlanTask).min(1).max(500),
  })
  .strict();
export type TaskPlan = z.infer<typeof TaskPlan>;

export type ImportPlanResult = {
  applied: boolean;
  projectId: string;
  taskIds: string[];
  taskCount: number;
  dependencyCount: number;
  criteriaCount: number;
  warnings: string[];
};

type TaskRecord = {
  id: string;
  project_id: string;
  title: string;
  status: string;
  prompt_id: string | null;
  description: string;
  execution_owner: string;
  prompt_text: string;
  ordinal: number;
  current_step: string | null;
  claimed_at: string | null;
  started_at: string | null;
  last_transition_at: string | null;
  completed_at: string | null;
  blocked_reason: string | null;
  skipped_reason: string | null;
  created_at: string;
  updated_at: string;
};

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function asStatus(value: string): TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus) ? (value as TaskStatus) : 'pending';
}

function asOwner(value: string): ExecutionOwner {
  return value === 'native_workflow' ? 'native_workflow' : 'mona_queue';
}

function boundedText(value: string | undefined, field: string, max: number, required: boolean): string {
  if (value === undefined) {
    if (required) throw stateError('invalid_request', `${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw stateError('invalid_request', `${field} must be text`);
  if (required && value.trim().length === 0) throw stateError('invalid_request', `${field} must not be empty`);
  if (value.length > max) throw stateError('invalid_request', `${field} must be at most ${max} characters`);
  return value;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/');
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * The task engine: durable prompt work items with explicit owners, verified
 * dependencies, evidence-gated completion and a deterministic resume path.
 * It writes only through ProjectStore's single transactional path.
 */
export class TaskService {
  private readonly store: ProjectStore;
  private readonly now: () => Date;
  private readonly maxPromptChars: number;

  constructor(store: ProjectStore, options: TaskServiceOptions = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
    this.maxPromptChars = options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
  }

  async createTask(input: CreateTaskInput): Promise<WorkTask> {
    return await this.store.write((tx) => {
      const id = this.insertTask(tx, input);
      const task = this.loadTask(tx.db, id);
      if (!task) throw stateError('internal', `task ${id} disappeared after insertion`);
      return task;
    });
  }

  async getTask(taskId: string): Promise<WorkTask | null> {
    return await this.store.read((db) => this.loadTask(db, taskId));
  }

  async listTasks(projectId: string): Promise<WorkTask[]> {
    return await this.store.read((db) => {
      const rows = db
        .prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY ordinal ASC, created_at ASC, id ASC')
        .all(projectId) as Array<{ id: string }>;
      return rows.map((row) => this.loadTask(db, row.id)).filter((task): task is WorkTask => task !== null);
    });
  }

  /**
   * Edit a task without ever rewriting evidence history. Structural edits
   * (owner, criteria, steps, dependencies) are refused once the task has
   * started or holds evidence; a new task is the honest way to change scope.
   */
  async updateTask(taskId: string, patch: TaskPatch): Promise<WorkTask> {
    return await this.store.write((tx) => {
      const row = this.requireTask(tx.db, taskId);
      const status = asStatus(row.status);
      const structural =
        patch.owner !== undefined ||
        patch.dependsOn !== undefined ||
        patch.steps !== undefined ||
        patch.criteria !== undefined ||
        patch.requirements !== undefined;
      if (structural && status !== 'pending' && status !== 'interrupted') {
        throw stateError('invalid_request', `task ${taskId} is ${status}; edit its scope only before it starts`);
      }
      if (patch.criteria !== undefined) {
        const evidence = tx.db.prepare('SELECT COUNT(*) AS count FROM task_evidence WHERE task_id = ?').get(taskId) as {
          count: number;
        };
        if (Number(evidence.count) > 0) {
          throw stateError(
            'invalid_request',
            'acceptance criteria cannot be rewritten after evidence exists; create a new task for the new scope',
          );
        }
      }

      const now = tx.now();
      const title = patch.title === undefined ? row.title : boundedText(patch.title, 'title', MAX_TITLE, true);
      const description =
        patch.description === undefined
          ? row.description
          : boundedText(patch.description, 'description', MAX_DESCRIPTION, false);
      const promptText =
        patch.promptText === undefined
          ? row.prompt_text
          : boundedText(patch.promptText, 'prompt text', MAX_PROMPT, false);
      const promptId = patch.promptId === undefined ? row.prompt_id : patch.promptId;
      const owner = patch.owner === undefined ? asOwner(row.execution_owner) : this.requireOwner(patch.owner);
      const ordinal = patch.ordinal === undefined ? row.ordinal : this.requireOrdinal(patch.ordinal);
      if (patch.owner !== undefined && status !== 'pending') {
        throw stateError(
          'invalid_request',
          'an execution owner is assigned before a task starts and cannot be swapped later',
        );
      }

      if (patch.dependsOn !== undefined) {
        this.replaceDependencies(tx, taskId, patch.dependsOn, row.project_id);
      }
      if (patch.steps !== undefined) {
        tx.db.prepare('DELETE FROM task_steps WHERE task_id = ?').run(taskId);
        this.insertSteps(tx, taskId, patch.steps);
      }
      if (patch.criteria !== undefined) {
        tx.db.prepare('DELETE FROM task_acceptance WHERE task_id = ?').run(taskId);
        this.insertCriteria(tx, taskId, patch.criteria);
      }
      if (patch.requirements !== undefined) {
        tx.db.prepare('DELETE FROM task_requirements WHERE task_id = ?').run(taskId);
        this.insertRequirements(tx, taskId, patch.requirements);
      }

      tx.db
        .prepare(
          `UPDATE tasks SET title = ?, description = ?, prompt_text = ?, prompt_id = ?, execution_owner = ?, ordinal = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(title, description, promptText, promptId, owner, ordinal, now, taskId);
      tx.bumpRevision();
      const task = this.loadTask(tx.db, taskId);
      if (!task) throw stateError('internal', `task ${taskId} disappeared after update`);
      return task;
    });
  }

  async addDependency(taskId: string, dependsOn: string): Promise<WorkTask> {
    return await this.store.write((tx) => {
      const row = this.requireTask(tx.db, taskId);
      if (asStatus(row.status) !== 'pending' && asStatus(row.status) !== 'interrupted') {
        throw stateError('invalid_request', 'dependencies can be changed only before a task starts');
      }
      const current = (
        tx.db
          .prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ? ORDER BY depends_on')
          .all(taskId) as Array<{
          depends_on: string;
        }>
      ).map((dependency) => dependency.depends_on);
      this.replaceDependencies(tx, taskId, [...current, dependsOn], row.project_id);
      return this.loadTask(tx.db, taskId) as WorkTask;
    });
  }

  async removeDependency(taskId: string, dependsOn: string): Promise<WorkTask> {
    return await this.store.write((tx) => {
      const row = this.requireTask(tx.db, taskId);
      if (asStatus(row.status) !== 'pending' && asStatus(row.status) !== 'interrupted') {
        throw stateError('invalid_request', 'dependencies can be changed only before a task starts');
      }
      tx.db.prepare('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on = ?').run(taskId, dependsOn);
      tx.bumpRevision();
      return this.loadTask(tx.db, taskId) as WorkTask;
    });
  }

  async removeTask(taskId: string, options: { force?: boolean } = {}): Promise<{ removed: boolean }> {
    return await this.store.write((tx) => {
      const row = this.requireTask(tx.db, taskId);
      if (asStatus(row.status) === 'running' || asStatus(row.status) === 'verifying') {
        throw stateError('invalid_request', 'an active task cannot be removed; interrupt it first');
      }
      const dependents = tx.db
        .prepare('SELECT COUNT(*) AS count FROM task_dependencies WHERE depends_on = ?')
        .get(taskId) as {
        count: number;
      };
      if (Number(dependents.count) > 0 && !options.force) {
        throw stateError(
          'invalid_request',
          `task ${taskId} is a prerequisite for ${dependents.count} other task(s); remove those links first`,
        );
      }
      tx.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
      tx.bumpRevision();
      return { removed: true };
    });
  }

  /** A prompt work board: tasks, dependencies, criteria and deterministic eligibility. */
  async board(projectId: string): Promise<TaskBoard> {
    return await this.store.read((db) => {
      const project = db.prepare('SELECT id, canonical_path FROM projects WHERE id = ?').get(projectId) as
        { id: string; canonical_path: string } | undefined;
      if (!project) throw stateError('not_found', `project ${projectId} does not exist`);
      const rows = db
        .prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY ordinal ASC, created_at ASC, id ASC')
        .all(projectId) as Array<{ id: string }>;
      const tasks = rows.map((row) => this.loadTask(db, row.id)).filter((task): task is WorkTask => task !== null);
      const statuses = new Map(tasks.map((task) => [task.id, task.status] as const));
      const entries: TaskBoardEntry[] = tasks.map((task) => ({
        task,
        eligibility: this.eligibilityFor(task, project.canonical_path, statuses, 'mona_queue'),
      }));
      const eligible = entries.filter((entry) => entry.eligibility.eligible).map((entry) => entry.task.id);
      const next = this.selectNext(tasks, project.canonical_path, 'mona_queue')?.id ?? null;
      return { projectId, generatedAt: this.now().toISOString(), tasks: entries, eligible, next };
    });
  }

  /**
   * Deterministic selection: an interrupted task first (resume the unfinished
   * work), then ordinal, prompt id, creation time and id. Every exclusion is
   * explained rather than hidden.
   */
  async nextEligible(
    projectId: string,
    options: { owner?: ExecutionOwner } = {},
  ): Promise<{ task: WorkTask; eligibility: TaskEligibility } | null> {
    return await this.store.read((db) => {
      const project = db.prepare('SELECT id, canonical_path FROM projects WHERE id = ?').get(projectId) as
        { id: string; canonical_path: string } | undefined;
      if (!project) throw stateError('not_found', `project ${projectId} does not exist`);
      const tasks = this.tasksForProject(db, projectId);
      const owner = options.owner ?? 'mona_queue';
      const task = this.selectNext(tasks, project.canonical_path, owner);
      if (!task) return null;
      const statuses = new Map(tasks.map((entry) => [entry.id, entry.status] as const));
      return { task, eligibility: this.eligibilityFor(task, project.canonical_path, statuses, owner) };
    });
  }

  /**
   * Claim a task for Mona's queue. The database's partial unique index is the
   * final guard: two workspaces may each run one task, one workspace may not.
   */
  async claim(taskId: string, actor = 'mona'): Promise<TaskClaim> {
    return await this.store.write((tx) => {
      const row = this.requireTask(tx.db, taskId);
      const task = this.loadTask(tx.db, taskId) as WorkTask;
      if (task.executionOwner !== 'mona_queue') {
        throw stateError(
          'not_eligible',
          `task ${taskId} is owned by ${task.executionOwner}; Mona's queue must not schedule it`,
        );
      }
      if (task.status !== 'pending' && task.status !== 'interrupted') {
        throw stateError('not_eligible', `task ${taskId} is ${task.status}, not claimable`);
      }
      const deps = this.dependencyStatus(tx.db, task);
      if (!deps.ok) throw stateError('not_eligible', deps.reason);
      const active = tx.db
        .prepare("SELECT id FROM tasks WHERE project_id = ? AND status IN ('running','verifying') AND id <> ?")
        .get(row.project_id, taskId) as { id?: string } | undefined;
      if (active?.id) {
        throw stateError(
          'not_eligible',
          `workspace ${row.project_id} already has active task ${active.id}; one mutating run per workspace`,
        );
      }

      const step = this.nextStep(task);
      const now = tx.now();
      this.transition(tx, row, 'running', 'claimed by Mona queue', actor, {
        claimedAt: now,
        startedAt: task.startedAt ?? now,
        currentStep: step?.id ?? null,
        blockedReason: null,
      });
      if (step && step.status !== 'running') {
        tx.db.prepare("UPDATE task_steps SET status = 'running', updated_at = ? WHERE id = ?").run(now, step.id);
      }
      const claimed = this.loadTask(tx.db, taskId) as WorkTask;
      return { task: claimed, prompt: this.buildPrompt(claimed, { enforce: true }), actor, claimedAt: now };
    });
  }

  async beginStep(taskId: string, stepId: string): Promise<WorkTask> {
    return await this.store.write((tx) => {
      const row = this.requireTask(tx.db, taskId);
      this.requireRunning(row);
      const step = tx.db
        .prepare('SELECT id, status FROM task_steps WHERE id = ? AND task_id = ?')
        .get(stepId, taskId) as { id: string; status: string } | undefined;
      if (!step) throw stateError('not_found', `step ${stepId} does not belong to task ${taskId}`);
      const now = tx.now();
      tx.db.prepare("UPDATE task_steps SET status = 'running', updated_at = ? WHERE id = ?").run(now, stepId);
      tx.db.prepare('UPDATE tasks SET current_step = ?, updated_at = ? WHERE id = ?').run(stepId, now, taskId);
      tx.bumpRevision();
      return this.loadTask(tx.db, taskId) as WorkTask;
    });
  }

  async completeStep(taskId: string, stepId: string, detail?: string): Promise<WorkTask> {
    return await this.store.write((tx) => {
      const row = this.requireTask(tx.db, taskId);
      this.requireRunning(row);
      const step = tx.db.prepare('SELECT id FROM task_steps WHERE id = ? AND task_id = ?').get(stepId, taskId) as
        { id: string } | undefined;
      if (!step) throw stateError('not_found', `step ${stepId} does not belong to task ${taskId}`);
      const now = tx.now();
      tx.db
        .prepare("UPDATE task_steps SET status = 'done', detail = COALESCE(?, detail), updated_at = ? WHERE id = ?")
        .run(detail === undefined ? null : boundedText(detail, 'step detail', 4_000, false), now, stepId);
      const next = tx.db
        .prepare("SELECT id FROM task_steps WHERE task_id = ? AND status = 'pending' ORDER BY position LIMIT 1")
        .get(taskId) as { id?: string } | undefined;
      if (next?.id) {
        tx.db.prepare("UPDATE task_steps SET status = 'running', updated_at = ? WHERE id = ?").run(now, next.id);
        tx.db.prepare('UPDATE tasks SET current_step = ?, updated_at = ? WHERE id = ?').run(next.id, now, taskId);
      } else {
        tx.db.prepare('UPDATE tasks SET current_step = NULL, updated_at = ? WHERE id = ?').run(now, taskId);
      }
      tx.bumpRevision();
      return this.loadTask(tx.db, taskId) as WorkTask;
    });
  }

  async failStep(taskId: string, stepId: string, detail: string): Promise<WorkTask> {
    return await this.store.write((tx) => {
      const row = this.requireTask(tx.db, taskId);
      this.requireRunning(row);
      const now = tx.now();
      tx.db
        .prepare("UPDATE task_steps SET status = 'failed', detail = ?, updated_at = ? WHERE id = ? AND task_id = ?")
        .run(boundedText(detail, 'failure detail', 4_000, true), now, stepId, taskId);
      tx.bumpRevision();
      return this.loadTask(tx.db, taskId) as WorkTask;
    });
  }

  /**
   * Record a check result. The hash is computed from the artifact itself (or a
   * supplied hash is verified against it), so a check cannot be satisfied by a
   * model's assertion alone.
   */
  async recordCheck(taskId: string, criterionId: string, input: CheckInput): Promise<TaskEvidence> {
    return await this.store.write((tx) => {
      const task = this.loadTask(tx.db, taskId);
      if (!task) throw stateError('not_found', `task ${taskId} does not exist`);
      if (task.status !== 'running' && task.status !== 'verifying') {
        throw stateError(
          'invalid_request',
          `checks are recorded while a task runs or verifies, not while ${task.status}`,
        );
      }
      const criterion = task.criteria.find((entry) => entry.id === criterionId);
      if (!criterion) throw stateError('not_found', `criterion ${criterionId} does not belong to task ${taskId}`);
      if (criterion.kind !== 'check') {
        throw stateError('invalid_request', `criterion ${criterionId} is human-only; a model cannot satisfy it`);
      }
      const project = tx.db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(task.projectId) as
        { canonical_path: string } | undefined;
      if (!project) throw stateError('not_found', `project ${task.projectId} does not exist`);
      const observed = this.evidencePath(project.canonical_path, input.path);
      const actual = sha256File(observed.absolutePath);
      if (input.sha256 !== undefined && input.sha256 !== actual) {
        throw stateError(
          'evidence_mismatch',
          `evidence hash for ${observed.relativePath} does not match the file on disk`,
          `observed ${input.sha256.slice(0, 12)}, actual ${actual.slice(0, 12)}`,
        );
      }
      const passed = input.passed !== false;
      const now = tx.now();
      const evidenceId = makeId('tev');
      tx.db
        .prepare(
          `INSERT INTO task_evidence(id, task_id, criterion_id, path, sha256, kind, note, recorded_at, stale, stale_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
        )
        .run(
          evidenceId,
          taskId,
          criterionId,
          observed.relativePath,
          actual,
          input.kind?.trim() || 'artifact',
          input.note ?? null,
          now,
        );
      if (passed) {
        tx.db
          .prepare(
            'UPDATE task_acceptance SET satisfied_at = ?, satisfied_note = ?, evidence_id = ? WHERE id = ? AND task_id = ?',
          )
          .run(now, input.note ?? null, evidenceId, criterionId, taskId);
      } else if (task.status === 'verifying') {
        const row = this.requireTask(tx.db, taskId);
        this.transition(tx, row, 'running', `check failed: ${criterion.description}`, 'mona', {
          completedAt: null,
        });
      }
      tx.bumpRevision();
      const stored = tx.db.prepare('SELECT * FROM task_evidence WHERE id = ?').get(evidenceId) as Record<
        string,
        unknown
      >;
      return this.toEvidence(stored);
    });
  }

  /** Human-only acceptance is explicit and cannot be satisfied by the engine. */
  async acceptHuman(taskId: string, criterionId: string, input: { actor: string; note: string }): Promise<WorkTask> {
    return await this.store.write((tx) => {
      const task = this.loadTask(tx.db, taskId);
      if (!task) throw stateError('not_found', `task ${taskId} does not exist`);
      const criterion = task.criteria.find((entry) => entry.id === criterionId);
      if (!criterion) throw stateError('not_found', `criterion ${criterionId} does not belong to task ${taskId}`);
      if (criterion.kind !== 'human') {
        throw stateError('invalid_request', `criterion ${criterionId} requires a recorded check, not human acceptance`);
      }
      if (task.status !== 'verifying' && task.status !== 'running') {
        throw stateError('invalid_request', `human acceptance applies while verifying, not while ${task.status}`);
      }
      const actor = boundedText(input.actor, 'actor', 200, true);
      const note = boundedText(input.note, 'acceptance note', 4_000, true);
      tx.db
        .prepare('UPDATE task_acceptance SET satisfied_at = ?, satisfied_note = ?, evidence_id = NULL WHERE id = ?')
        .run(tx.now(), `${actor}: ${note}`, criterionId);
      tx.bumpRevision();
      return this.loadTask(tx.db, taskId) as WorkTask;
    });
  }

  /** Completion requires every configured check, every human item and fresh evidence. */
  async completeTask(taskId: string, actor = 'victor'): Promise<CompletionReport> {
    // Re-hash linked artifacts before deciding. If an artifact changed after the
    // check was recorded, the refusal must outlive the transaction, so the stale
    // flags (and any resulting reopen) are committed by this pass first.
    await this.refreshEvidenceForTask(taskId);
    return await this.store.write((tx) => {
      const task = this.loadTask(tx.db, taskId);
      if (!task) throw stateError('not_found', `task ${taskId} does not exist`);
      if (task.status !== 'verifying') {
        throw stateError('invalid_request', `task ${taskId} is ${task.status}; only a verifying task can complete`);
      }
      const gaps = this.completionGaps(task);
      if (gaps.length > 0) {
        throw stateError('criteria_unsatisfied', `task ${taskId} cannot complete`, gaps.join('; '));
      }
      const stepGaps = this.stepGaps(task);
      if (stepGaps.length > 0) {
        throw stateError('criteria_unsatisfied', `task ${taskId} still has unfinished steps`, stepGaps.join('; '));
      }
      const row = this.requireTask(tx.db, taskId);
      this.transition(tx, row, 'completed', 'acceptance evidence verified', boundedText(actor, 'actor', 200, true), {
        completedAt: tx.now(),
        currentStep: null,
      });
      return { taskId, completed: true, status: 'completed', gaps: [] };
    });
  }

  async requestVerification(taskId: string, actor = 'mona'): Promise<WorkTask> {
    return await this.store.write((tx) => {
      const row = this.requireTask(tx.db, taskId);
      if (asStatus(row.status) !== 'running') {
        throw stateError('invalid_request', `task ${taskId} is ${row.status}, not running`);
      }
      const task = this.loadTask(tx.db, taskId) as WorkTask;
      const stepGaps = this.stepGaps(task);
      if (stepGaps.length > 0) {
        throw stateError('criteria_unsatisfied', `task ${taskId} still has unfinished steps`, stepGaps.join('; '));
      }
      this.transition(tx, row, 'verifying', 'implementation ready for acceptance', actor, { completedAt: null });
      return this.loadTask(tx.db, taskId) as WorkTask;
    });
  }

  async rejectVerification(taskId: string, reason: string, actor = 'victor'): Promise<WorkTask> {
    return await this.store.write((tx) => {
      const row = this.requireTask(tx.db, taskId);
      if (asStatus(row.status) !== 'verifying') {
        throw stateError('invalid_request', `task ${taskId} is ${row.status}, not verifying`);
      }
      this.transition(tx, row, 'running', boundedText(reason, 'reason', 4_000, true), actor, { completedAt: null });
      return this.loadTask(tx.db, taskId) as WorkTask;
    });
  }

  async interruptTask(taskId: string, reason: string, actor = 'mona'): Promise<WorkTask> {
    return await this.store.write((tx) => {
      const row = this.requireTask(tx.db, taskId);
      const status = asStatus(row.status);
      if (status !== 'running' && status !== 'verifying') {
        throw stateError('invalid_request', `task ${taskId} is ${status}; nothing to interrupt`);
      }
      const current = this.recordedStep(tx.db, taskId);
      this.transition(tx, row, 'interrupted', boundedText(reason, 'reason', 4_000, true), actor, {
        currentStep: current,
        completedAt: null,
      });
      return this.loadTask(tx.db, taskId) as WorkTask;
    });
  }

  async blockTask(taskId: string, reason: string, actor = 'mona'): Promise<WorkTask> {
    return await this.store.write((tx) => {
      const row = this.requireTask(tx.db, taskId);
      const status = asStatus(row.status);
      if (status !== 'running' && status !== 'verifying') {
        throw stateError('invalid_request', `task ${taskId} is ${status}; only active work can block`);
      }
      const current = this.recordedStep(tx.db, taskId);
      this.transition(tx, row, 'blocked', boundedText(reason, 'reason', 4_000, true), actor, {
        currentStep: current,
        blockedReason: reason,
        completedAt: null,
      });
      return this.loadTask(tx.db, taskId) as WorkTask;
    });
  }

  /**
   * Blocked work returns to running only with a recorded decision or new
   * evidence; acknowledgement alone is not new evidence.
   */
  async unblockTask(
    taskId: string,
    input: { reason: string; actor: string; evidencePath?: string },
  ): Promise<WorkTask> {
    return await this.store.write((tx) => {
      const row = this.requireTask(tx.db, taskId);
      if (asStatus(row.status) !== 'blocked') {
        throw stateError('invalid_request', `task ${taskId} is ${row.status}, not blocked`);
      }
      const reason = boundedText(input.reason, 'reason', 4_000, true);
      if (input.evidencePath === undefined && reason.trim().length < 12) {
        throw stateError(
          'invalid_request',
          'unblocking requires material new evidence or an explicit decision recorded with a reason',
        );
      }
      const active = tx.db
        .prepare("SELECT id FROM tasks WHERE project_id = ? AND status IN ('running','verifying') AND id <> ?")
        .get(row.project_id, taskId) as { id?: string } | undefined;
      if (active?.id) {
        throw stateError('not_eligible', `workspace ${row.project_id} already has active task ${active.id}`);
      }
      this.transition(tx, row, 'running', reason, boundedText(input.actor, 'actor', 200, true), {
        blockedReason: null,
        currentStep: this.recordedStep(tx.db, taskId),
      });
      return this.loadTask(tx.db, taskId) as WorkTask;
    });
  }

  async skipTask(taskId: string, input: { decision: string; actor: string }): Promise<WorkTask> {
    return await this.store.write((tx) => {
      const row = this.requireTask(tx.db, taskId);
      const status = asStatus(row.status);
      if (status !== 'pending' && status !== 'interrupted' && status !== 'blocked') {
        throw stateError('invalid_request', `task ${taskId} is ${status}; it cannot be skipped now`);
      }
      const decision = boundedText(input.decision, 'scope decision', 4_000, true);
      this.transition(tx, row, 'skipped', decision, boundedText(input.actor, 'actor', 200, true), {
        skippedReason: decision,
      });
      return this.loadTask(tx.db, taskId) as WorkTask;
    });
  }

  /**
   * Startup reconciliation: an active task with no live run is interrupted, not
   * silently resumed. The recorded step survives for the next resume.
   */
  async reconcile(projectId: string, liveTaskIds: readonly string[] = []): Promise<ReconcileReceipt[]> {
    return await this.store.write((tx) => {
      const live = new Set(liveTaskIds);
      const rows = tx.db
        .prepare("SELECT * FROM tasks WHERE project_id = ? AND status IN ('running','verifying') ORDER BY ordinal, id")
        .all(projectId) as TaskRecord[];
      const receipts: ReconcileReceipt[] = [];
      for (const row of rows) {
        if (live.has(row.id)) continue;
        const fromStatus = asStatus(row.status);
        const step = this.recordedStep(tx.db, row.id);
        this.transition(
          tx,
          row,
          'interrupted',
          'no live run was found at reconciliation; resume verifies the recorded step before continuing',
          'mona',
          { currentStep: step, completedAt: null },
        );
        receipts.push({ taskId: row.id, fromStatus, step, reason: 'no live run at reconciliation' });
      }
      return receipts;
    });
  }

  /** Resume the earliest unfinished task at its recorded step, after deps pass. */
  async resumeTask(taskId: string, actor = 'victor'): Promise<WorkTask> {
    return await this.store.write((tx) => {
      const row = this.requireTask(tx.db, taskId);
      if (asStatus(row.status) !== 'interrupted') {
        throw stateError('invalid_request', `task ${taskId} is ${row.status}, not interrupted`);
      }
      const task = this.loadTask(tx.db, taskId) as WorkTask;
      const deps = this.dependencyStatus(tx.db, task);
      if (!deps.ok) throw stateError('not_eligible', deps.reason);
      const active = tx.db
        .prepare("SELECT id FROM tasks WHERE project_id = ? AND status IN ('running','verifying') AND id <> ?")
        .get(row.project_id, taskId) as { id?: string } | undefined;
      if (active?.id) {
        throw stateError('not_eligible', `workspace ${row.project_id} already has active task ${active.id}`);
      }
      const resumeAt = this.nextStep(task);
      this.transition(
        tx,
        row,
        'running',
        `resumed at ${resumeAt?.title ?? 'verification'}`,
        boundedText(actor, 'actor', 200, true),
        {
          currentStep: resumeAt?.id ?? null,
          blockedReason: null,
        },
      );
      if (!resumeAt) {
        const resumed = this.requireTask(tx.db, taskId);
        this.transition(tx, resumed, 'verifying', 'all recorded steps are done; acceptance is next', actor, {});
      } else if (resumeAt.status !== 'running') {
        tx.db
          .prepare("UPDATE task_steps SET status = 'running', updated_at = ? WHERE id = ?")
          .run(tx.now(), resumeAt.id);
      }
      return this.loadTask(tx.db, taskId) as WorkTask;
    });
  }

  /**
   * Invalidate evidence whose artifact changed. A completed task reopens to
   * verifying and keeps its history; it never silently stays complete.
   */
  async revalidate(projectId: string, observations: readonly RevalidateInput[]): Promise<RevalidateResult> {
    return await this.store.write((tx) => {
      const project = tx.db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(projectId) as
        { canonical_path: string } | undefined;
      if (!project) throw stateError('not_found', `project ${projectId} does not exist`);
      const evidenceRows = tx.db
        .prepare(
          `SELECT e.* FROM task_evidence e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = ? AND e.stale = 0`,
        )
        .all(projectId) as Array<Record<string, unknown>>;
      const invalidated: RevalidateResult['invalidated'] = [];
      const affected = new Set<string>();
      let checked = 0;
      for (const observation of observations) {
        const observed = this.evidencePath(project.canonical_path, observation.path, { mustExist: false });
        let current: string | null = observation.sha256 ?? null;
        if (current === null) {
          try {
            current = sha256File(observed.absolutePath);
          } catch {
            current = null;
          }
        }
        for (const row of evidenceRows) {
          if (normalizeRelativePath(String(row.path)) !== observed.relativePath) continue;
          checked += 1;
          if (current !== null && current === String(row.sha256)) continue;
          const reason =
            current === null
              ? `artifact ${observed.relativePath} is missing; its recorded evidence is stale`
              : `artifact ${observed.relativePath} changed; its recorded evidence is stale`;
          tx.db
            .prepare('UPDATE task_evidence SET stale = 1, stale_reason = ? WHERE id = ?')
            .run(reason, String(row.id));
          const taskId = String(row.task_id);
          affected.add(taskId);
          invalidated.push({ taskId, evidenceId: String(row.id), path: observed.relativePath, reason });
        }
      }
      const reopened: string[] = [];
      for (const taskId of affected) {
        const row = this.requireTask(tx.db, taskId);
        if (asStatus(row.status) === 'completed') {
          this.transition(tx, row, 'verifying', 'recorded evidence became stale after a workspace change', 'mona', {
            completedAt: null,
          });
          reopened.push(taskId);
        }
      }
      if (invalidated.length > 0) tx.bumpRevision();
      return { checked, invalidated, reopened };
    });
  }

  /** The exact text that will be submitted, with no hidden document injection. */
  async previewContext(taskId: string): Promise<TaskContextPreview> {
    return await this.store.read((db) => {
      const task = this.loadTask(db, taskId);
      if (!task) throw stateError('not_found', `task ${taskId} does not exist`);
      const prompt = this.buildPrompt(task, { enforce: false, limit: 1_000_000 });
      const notes = [
        'Only the selected task, its acceptance criteria, prerequisites and requirement ids are included.',
        'Whole Mona design or prompt documents are never injected automatically.',
      ];
      if (prompt.characters > this.maxPromptChars) {
        notes.push(
          `This prompt is ${prompt.characters} characters; the dispatch limit is ${this.maxPromptChars}, so claiming will refuse until it is shortened.`,
        );
      }
      return { taskId, title: task.title, ...prompt, notes };
    });
  }

  /** Deterministic short handoff generated from recorded state. */
  async handoff(projectId: string): Promise<string> {
    return await this.store.read((db) => {
      const project = db.prepare('SELECT id, label, canonical_path FROM projects WHERE id = ?').get(projectId) as
        { id: string; label: string; canonical_path: string } | undefined;
      if (!project) throw stateError('not_found', `project ${projectId} does not exist`);
      const tasks = this.tasksForProject(db, projectId);
      const active = tasks.find((task) => task.status === 'running' || task.status === 'verifying');
      const interrupted = tasks.find((task) => task.status === 'interrupted');
      const next = active ?? interrupted ?? this.selectNext(tasks, project.canonical_path, 'mona_queue') ?? null;
      const complete = tasks.filter((task) => task.status === 'completed').length;
      const blocked = tasks.filter((task) => task.status === 'blocked');
      const lines: string[] = [];
      lines.push(`# ${project.label} — handoff`);
      lines.push('');
      lines.push(`Generated: ${this.now().toISOString()}`);
      lines.push(`Tasks: ${tasks.length} total, ${complete} completed, ${blocked.length} blocked.`);
      lines.push('');
      if (next) {
        const step = next.steps.find((entry) => entry.id === next.currentStep);
        const nextLine =
          next.status === 'completed' ? 'Verified task' : next.status === 'pending' ? 'Next task' : 'Current task';
        lines.push(`## ${nextLine}`);
        lines.push('');
        lines.push(`- Task: ${next.id} — ${next.title}`);
        lines.push(`- Status: ${next.status}`);
        lines.push(`- Owner: ${next.executionOwner}`);
        if (step) lines.push(`- Resume at: ${step.title} (${step.status})`);
        const done = next.steps.filter((entry) => entry.status === 'done').map((entry) => entry.title);
        if (done.length > 0) lines.push(`- Completed steps: ${done.join('; ')}`);
        const gaps = this.completionGaps(next);
        if (next.status === 'verifying') {
          lines.push(`- Completion gaps: ${gaps.length === 0 ? 'none; ready to complete' : gaps.join('; ')}`);
        }
        if (next.dependencies.length > 0) lines.push(`- Depends on: ${next.dependencies.join(', ')}`);
        const evidence = next.evidence.filter((entry) => !entry.stale).map((entry) => entry.path);
        if (evidence.length > 0) lines.push(`- Evidence: ${evidence.join(', ')}`);
      } else {
        lines.push('## Next task');
        lines.push('');
        lines.push('- None eligible. Inspect blocked prerequisites or add a bounded task.');
      }
      const completed = tasks
        .filter((task) => task.status === 'completed')
        .sort(
          (left, right) =>
            (right.completedAt ?? '').localeCompare(left.completedAt ?? '') || left.id.localeCompare(right.id),
        )
        .slice(0, 5);
      if (completed.length > 0) {
        lines.push('');
        lines.push('## Verified work');
        lines.push('');
        for (const task of completed) {
          const evidence = task.evidence.filter((entry) => !entry.stale).map((entry) => entry.path);
          lines.push(`- ${task.id}: ${task.title}${evidence.length > 0 ? ` (${evidence.join(', ')})` : ''}`);
        }
      }
      if (blocked.length > 0) {
        lines.push('');
        lines.push('## Open blockers');
        lines.push('');
        for (const task of blocked) {
          lines.push(`- ${task.id} — ${task.title}: ${task.blockedReason ?? 'no reason recorded'}`);
        }
      }
      lines.push('');
      lines.push('## Files');
      lines.push('');
      lines.push(`- Workspace: ${project.canonical_path}`);
      lines.push('- State: local project SQLite (not the Mona build ledger)');
      return `${lines.join('\n')}\n`;
    });
  }

  /** Write the generated handoff atomically; the caller chooses the location. */
  async writeHandoff(projectId: string, file: string): Promise<{ file: string; bytes: number }> {
    const text = await this.handoff(projectId);
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, text, 'utf8');
    renameSync(temp, file);
    return { file, bytes: Buffer.byteLength(text, 'utf8') };
  }

  /**
   * The one task the Mona queue runs, then it stops. A native-owned task is
   * never selected, so the queue and a native workflow cannot double-schedule.
   */
  async runOnce(projectId: string, executor: TaskExecutor): Promise<QueueRunResult> {
    const selection = await this.nextEligible(projectId, { owner: 'mona_queue' });
    if (!selection) {
      return {
        ran: false,
        reason: 'no eligible Mona-owned task; blocked, native-owned and unfinished work was left alone',
        taskId: null,
        prompt: null,
        promptSha256: null,
        status: null,
        completion: null,
        error: null,
      };
    }
    let claim: TaskClaim;
    try {
      claim = await this.claim(selection.task.id, 'mona-queue');
    } catch (error) {
      return {
        ran: false,
        reason: 'claim refused',
        taskId: selection.task.id,
        prompt: null,
        promptSha256: null,
        status: null,
        completion: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const control: TaskRunControl = {
      taskId: claim.task.id,
      prompt: claim.prompt.text,
      beginStep: async (stepId) => {
        await this.beginStep(claim.task.id, stepId);
      },
      completeStep: async (stepId, detail) => {
        await this.completeStep(claim.task.id, stepId, detail);
      },
      failStep: async (stepId, detail) => {
        await this.failStep(claim.task.id, stepId, detail);
      },
      recordCheck: async (criterionId, input) => {
        await this.recordCheck(claim.task.id, criterionId, input);
      },
    };

    try {
      await executor(control);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = await this.getTask(claim.task.id);
      if (current && (current.status === 'running' || current.status === 'verifying')) {
        await this.interruptTask(claim.task.id, `executor failed: ${message}`.slice(0, 4_000), 'mona-queue');
      }
      return {
        ran: true,
        reason: 'executor failed; the task was interrupted, not completed',
        taskId: claim.task.id,
        prompt: claim.prompt.text,
        promptSha256: claim.prompt.sha256,
        status: 'interrupted',
        completion: null,
        error: message,
      };
    }

    let task = await this.getTask(claim.task.id);
    if (!task) throw stateError('internal', `task ${claim.task.id} disappeared during its run`);
    if (task.status === 'running') {
      const gaps = this.stepGaps(task);
      if (gaps.length === 0) {
        task = await this.requestVerification(task.id, 'mona-queue');
      } else {
        task = await this.interruptTask(
          task.id,
          `executor returned with unfinished steps: ${gaps.join('; ')}`.slice(0, 4_000),
          'mona-queue',
        );
      }
    }
    let completion: CompletionReport | null = null;
    if (task.status === 'verifying') {
      const gaps = this.completionGaps(task);
      if (gaps.length === 0 && this.stepGaps(task).length === 0) {
        completion = await this.completeTask(task.id, 'mona-queue');
        task = (await this.getTask(task.id)) as WorkTask;
      } else {
        completion = { taskId: task.id, completed: false, status: task.status, gaps };
      }
    }
    return {
      ran: true,
      reason: 'one task ran; the queue stops here',
      taskId: task.id,
      prompt: claim.prompt.text,
      promptSha256: claim.prompt.sha256,
      status: task.status,
      completion,
      error: null,
    };
  }

  /**
   * Import a prompt pack. Without `apply`, nothing is written; with it, every
   * task lands pending and inert. Nothing is dispatched, claimed or started.
   */
  async importPlan(input: unknown, options: { apply?: boolean } = {}): Promise<ImportPlanResult> {
    const parsed = TaskPlan.safeParse(input);
    if (!parsed.success) {
      throw stateError(
        'invalid_request',
        'task plan does not match the mona.task-plan schema',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      );
    }
    const plan = parsed.data;
    const taskIds = plan.tasks.map((task) => task.id);
    const dependencyCount = plan.tasks.reduce((sum, task) => sum + (task.depends_on?.length ?? 0), 0);
    const criteriaCount = plan.tasks.reduce((sum, task) => sum + (task.acceptance?.length ?? 0), 0);
    const warnings: string[] = [];
    for (const task of plan.tasks) {
      if ((task.acceptance?.length ?? 0) === 0) {
        warnings.push(`${task.id} has no acceptance criteria and cannot be completed until some are added`);
      }
    }
    if (options.apply !== true) {
      return await this.store.read((db) => {
        const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(plan.project_id) as
          { id: string } | undefined;
        if (!project) throw stateError('not_found', `project ${plan.project_id} does not exist`);
        this.validatePlanGraph(db, plan);
        return {
          applied: false,
          projectId: plan.project_id,
          taskIds,
          taskCount: plan.tasks.length,
          dependencyCount,
          criteriaCount,
          warnings,
        };
      });
    }
    return await this.store.write((tx) => {
      const project = tx.db.prepare('SELECT id FROM projects WHERE id = ?').get(plan.project_id) as
        { id: string } | undefined;
      if (!project) throw stateError('not_found', `project ${plan.project_id} does not exist`);
      this.validatePlanGraph(tx.db, plan);
      // Insert every task before any edge so a plan may reference a later task.
      for (const [index, task] of plan.tasks.entries()) {
        this.insertTask(
          tx,
          {
            projectId: plan.project_id,
            title: task.title,
            ...(task.description === undefined ? {} : { description: task.description }),
            ...(task.prompt_text === undefined ? {} : { promptText: task.prompt_text }),
            promptId: task.prompt_id ?? null,
            owner: task.owner,
            ordinal: task.ordinal ?? index + 1,
            dependsOn: [],
            steps: task.steps ?? [],
            criteria: task.acceptance ?? [],
            requirements: (task.requirements ?? []).map((requirement) => ({
              requirementId: requirement.requirement_id,
              ...(requirement.criterion_id === undefined ? {} : { criterionId: requirement.criterion_id }),
            })),
          },
          task.id,
          { deferDependencies: true },
        );
      }
      for (const task of plan.tasks) {
        this.insertDependencies(tx, task.id, task.depends_on ?? [], plan.project_id);
      }
      return {
        applied: true,
        projectId: plan.project_id,
        taskIds,
        taskCount: plan.tasks.length,
        dependencyCount,
        criteriaCount,
        warnings,
      };
    });
  }

  // --- internals ---------------------------------------------------------

  private insertTask(
    tx: WriteTransaction,
    input: CreateTaskInput,
    forcedId?: string,
    options: { deferDependencies?: boolean } = {},
  ): string {
    const project = tx.db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId) as
      { id: string } | undefined;
    if (!project) throw stateError('not_found', `project ${input.projectId} does not exist`);
    const title = boundedText(input.title, 'title', MAX_TITLE, true);
    const description = boundedText(input.description, 'description', MAX_DESCRIPTION, false);
    const promptText = boundedText(input.promptText, 'prompt text', MAX_PROMPT, false);
    const owner = this.requireOwner(input.owner);
    const ordinal =
      input.ordinal === undefined
        ? ((
            tx.db
              .prepare('SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM tasks WHERE project_id = ?')
              .get(input.projectId) as {
              ordinal: number;
            }
          ).ordinal ?? 0) + 1
        : this.requireOrdinal(input.ordinal);
    const id = forcedId ?? makeId('tsk');
    const now = tx.now();
    tx.db
      .prepare(
        `INSERT INTO tasks(id, project_id, title, status, prompt_id, description, execution_owner, prompt_text, ordinal, last_transition_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.projectId, title, input.promptId ?? null, description, owner, promptText, ordinal, now, now, now);
    if (options.deferDependencies !== true) {
      this.insertDependencies(tx, id, input.dependsOn ?? [], input.projectId);
    }
    this.insertSteps(tx, id, input.steps ?? []);
    this.insertCriteria(tx, id, input.criteria ?? []);
    this.insertRequirements(tx, id, input.requirements ?? []);
    this.writeTransition(tx, id, null, 'pending', 'task created', 'mona');
    tx.bumpRevision();
    return id;
  }

  private insertDependencies(
    tx: WriteTransaction,
    taskId: string,
    dependsOn: readonly string[],
    projectId: string,
  ): void {
    const seen = new Set<string>();
    if (dependsOn.length > MAX_DEPENDENCIES) {
      throw stateError('invalid_request', `a task may have at most ${MAX_DEPENDENCIES} prerequisites`);
    }
    for (const dependency of dependsOn) {
      if (dependency === taskId) throw stateError('dependency_cycle', 'a task cannot depend on itself');
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      const row = tx.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(dependency) as
        { project_id: string } | undefined;
      if (!row) throw stateError('not_found', `prerequisite ${dependency} does not exist`);
      if (row.project_id !== projectId) {
        throw stateError('invalid_request', `prerequisite ${dependency} belongs to another workspace`);
      }
      tx.db.prepare('INSERT INTO task_dependencies(task_id, depends_on) VALUES (?, ?)').run(taskId, dependency);
    }
    this.assertAcyclic(tx.db, projectId);
  }

  private replaceDependencies(
    tx: WriteTransaction,
    taskId: string,
    dependsOn: readonly string[],
    projectId: string,
  ): void {
    const previous = (
      tx.db.prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ?').all(taskId) as Array<{
        depends_on: string;
      }>
    ).map((row) => row.depends_on);
    tx.db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(taskId);
    try {
      this.insertDependencies(tx, taskId, dependsOn, projectId);
    } catch (error) {
      // Put the previous edges back when the replacement would break the graph.
      tx.db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(taskId);
      for (const dependency of previous) {
        tx.db.prepare('INSERT INTO task_dependencies(task_id, depends_on) VALUES (?, ?)').run(taskId, dependency);
      }
      throw error;
    }
  }

  private insertSteps(tx: WriteTransaction, taskId: string, steps: readonly TaskStepInput[]): void {
    if (steps.length > MAX_STEPS) throw stateError('invalid_request', `a task may have at most ${MAX_STEPS} steps`);
    const now = tx.now();
    for (const [index, step] of steps.entries()) {
      tx.db
        .prepare(
          'INSERT INTO task_steps(id, task_id, position, title, status, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          makeId('tst'),
          taskId,
          index + 1,
          boundedText(step.title, 'step title', MAX_TITLE, true),
          'pending',
          step.detail === undefined ? null : boundedText(step.detail, 'step detail', 4_000, false),
          now,
        );
    }
  }

  private insertCriteria(tx: WriteTransaction, taskId: string, criteria: readonly TaskCriterionInput[]): void {
    if (criteria.length > MAX_CRITERIA) {
      throw stateError('invalid_request', `a task may have at most ${MAX_CRITERIA} acceptance criteria`);
    }
    for (const [index, criterion] of criteria.entries()) {
      const kind = criterion.kind ?? 'check';
      if (kind !== 'check' && kind !== 'human')
        throw stateError('invalid_request', 'criterion kind must be check or human');
      tx.db
        .prepare(
          `INSERT INTO task_acceptance(id, task_id, position, description, kind, required, satisfied_at, satisfied_note, evidence_id)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          makeId('tac'),
          taskId,
          index + 1,
          boundedText(criterion.description, 'criterion description', 4_000, true),
          kind,
          criterion.required === false ? 0 : 1,
        );
    }
  }

  private insertRequirements(
    tx: WriteTransaction,
    taskId: string,
    requirements: readonly TaskRequirementInput[],
  ): void {
    if (requirements.length > MAX_REQUIREMENTS) {
      throw stateError('invalid_request', `a task may reference at most ${MAX_REQUIREMENTS} requirements`);
    }
    const seen = new Set<string>();
    for (const requirement of requirements) {
      const requirementId = boundedText(requirement.requirementId, 'requirement id', 200, true);
      const criterionId = requirement.criterionId ?? '';
      const key = `${requirementId}\u0000${criterionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tx.db
        .prepare('INSERT INTO task_requirements(task_id, requirement_id, criterion_id) VALUES (?, ?, ?)')
        .run(taskId, requirementId, criterionId);
    }
  }

  private loadTask(db: DatabaseSync, taskId: string): WorkTask | null {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRecord | undefined;
    if (!row) return null;
    const steps = db.prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY position').all(taskId) as Array<
      Record<string, unknown>
    >;
    const criteria = db
      .prepare('SELECT * FROM task_acceptance WHERE task_id = ? ORDER BY position')
      .all(taskId) as Array<Record<string, unknown>>;
    const requirements = db
      .prepare(
        'SELECT requirement_id, criterion_id FROM task_requirements WHERE task_id = ? ORDER BY requirement_id, criterion_id',
      )
      .all(taskId) as Array<{ requirement_id: string; criterion_id: string }>;
    const dependencies = (
      db
        .prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ? ORDER BY depends_on')
        .all(taskId) as Array<{
        depends_on: string;
      }>
    ).map((dependency) => dependency.depends_on);
    const dependents = (
      db.prepare('SELECT task_id FROM task_dependencies WHERE depends_on = ? ORDER BY task_id').all(taskId) as Array<{
        task_id: string;
      }>
    ).map((dependent) => dependent.task_id);
    const evidence = (
      db.prepare('SELECT * FROM task_evidence WHERE task_id = ? ORDER BY recorded_at, id').all(taskId) as Array<
        Record<string, unknown>
      >
    ).map((entry) => this.toEvidence(entry));
    const transitions = (
      db.prepare('SELECT * FROM task_transitions WHERE task_id = ? ORDER BY at, rowid').all(taskId) as Array<
        Record<string, unknown>
      >
    ).map((entry) => ({
      id: String(entry.id),
      taskId: String(entry.task_id),
      fromStatus: entry.from_status === null ? null : asStatus(String(entry.from_status)),
      toStatus: asStatus(String(entry.to_status)),
      reason: String(entry.reason),
      actor: String(entry.actor),
      at: String(entry.at),
    }));
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      status: asStatus(row.status),
      promptId: row.prompt_id,
      description: row.description,
      executionOwner: asOwner(row.execution_owner),
      promptText: row.prompt_text,
      ordinal: Number(row.ordinal ?? 0),
      currentStep: row.current_step,
      claimedAt: row.claimed_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      blockedReason: row.blocked_reason,
      skippedReason: row.skipped_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      steps: steps.map((step) => ({
        id: String(step.id),
        taskId: String(step.task_id),
        position: Number(step.position),
        title: String(step.title),
        status: String(step.status) as TaskStepStatus,
        detail: step.detail === null ? null : String(step.detail),
        updatedAt: String(step.updated_at),
      })),
      criteria: criteria.map((criterion) => ({
        id: String(criterion.id),
        taskId: String(criterion.task_id),
        position: Number(criterion.position),
        description: String(criterion.description),
        kind: criterion.kind === 'human' ? 'human' : 'check',
        required: Number(criterion.required) === 1,
        satisfiedAt: criterion.satisfied_at === null ? null : String(criterion.satisfied_at),
        satisfiedNote: criterion.satisfied_note === null ? null : String(criterion.satisfied_note),
        evidenceId: criterion.evidence_id === null ? null : String(criterion.evidence_id),
      })),
      requirements: requirements.map((requirement) => ({
        requirementId: requirement.requirement_id,
        criterionId: requirement.criterion_id === '' ? null : requirement.criterion_id,
      })),
      dependencies,
      dependents,
      evidence,
      transitions,
    };
  }

  private toEvidence(row: Record<string, unknown>): TaskEvidence {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      criterionId: row.criterion_id === null ? null : String(row.criterion_id),
      path: String(row.path),
      sha256: String(row.sha256),
      kind: String(row.kind),
      note: row.note === null ? null : String(row.note),
      recordedAt: String(row.recorded_at),
      stale: Number(row.stale) === 1,
      staleReason: row.stale_reason === null ? null : String(row.stale_reason),
    };
  }

  private async refreshEvidenceForTask(taskId: string): Promise<void> {
    await this.store.write((tx) => {
      const task = this.loadTask(tx.db, taskId);
      if (!task) throw stateError('not_found', `task ${taskId} does not exist`);
      const project = tx.db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(task.projectId) as
        { canonical_path: string } | undefined;
      if (!project) return;
      let changed = 0;
      for (const evidence of task.evidence) {
        if (evidence.stale) continue;
        const resolved = this.evidencePath(project.canonical_path, evidence.path, { mustExist: false });
        let current: string | null;
        try {
          current = sha256File(resolved.absolutePath);
        } catch {
          current = null;
        }
        if (current === evidence.sha256) continue;
        const reason =
          current === null
            ? `artifact ${evidence.path} is missing; its recorded evidence is stale`
            : `artifact ${evidence.path} changed; its recorded evidence is stale`;
        tx.db.prepare('UPDATE task_evidence SET stale = 1, stale_reason = ? WHERE id = ?').run(reason, evidence.id);
        changed += 1;
      }
      if (changed > 0) {
        if (task.status === 'completed') {
          const row = this.requireTask(tx.db, taskId);
          this.transition(tx, row, 'verifying', 'recorded evidence became stale', 'mona', { completedAt: null });
        } else {
          tx.bumpRevision();
        }
      }
    });
  }

  private requireTask(db: DatabaseSync, taskId: string): TaskRecord {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRecord | undefined;
    if (!row) throw stateError('not_found', `task ${taskId} does not exist`);
    return row;
  }

  private requireOwner(owner: ExecutionOwner): ExecutionOwner {
    if (owner !== 'mona_queue' && owner !== 'native_workflow') {
      throw stateError('invalid_request', 'execution owner must be mona_queue or native_workflow');
    }
    return owner;
  }

  private requireOrdinal(value: number): number {
    if (!Number.isInteger(value) || value < 0)
      throw stateError('invalid_request', 'ordinal must be a non-negative integer');
    return value;
  }

  private requireRunning(row: TaskRecord): void {
    if (asStatus(row.status) !== 'running') {
      throw stateError('invalid_request', `task ${row.id} is ${row.status}; steps change only while it is running`);
    }
  }

  private transition(
    tx: WriteTransaction,
    row: TaskRecord,
    to: TaskStatus,
    reason: string,
    actor: string,
    patch: {
      currentStep?: string | null;
      claimedAt?: string | null;
      startedAt?: string | null;
      completedAt?: string | null;
      blockedReason?: string | null;
      skippedReason?: string | null;
    },
  ): void {
    const from = asStatus(row.status);
    if (!TRANSITIONS[from].includes(to)) {
      throw stateError('invalid_request', `task ${row.id} cannot move from ${from} to ${to}`);
    }
    const now = tx.now();
    tx.db
      .prepare(
        `UPDATE tasks SET status = ?, current_step = ?, claimed_at = ?, started_at = ?, completed_at = ?,
                          blocked_reason = ?, skipped_reason = ?, last_transition_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        to,
        patch.currentStep === undefined ? row.current_step : patch.currentStep,
        patch.claimedAt === undefined ? row.claimed_at : patch.claimedAt,
        patch.startedAt === undefined ? row.started_at : patch.startedAt,
        patch.completedAt === undefined ? row.completed_at : patch.completedAt,
        patch.blockedReason === undefined ? row.blocked_reason : patch.blockedReason,
        patch.skippedReason === undefined ? row.skipped_reason : patch.skippedReason,
        now,
        now,
        row.id,
      );
    this.writeTransition(tx, row.id, from, to, reason, actor);
    tx.bumpRevision();
  }

  private writeTransition(
    tx: WriteTransaction,
    taskId: string,
    from: TaskStatus | null,
    to: TaskStatus,
    reason: string,
    actor: string,
  ): void {
    tx.db
      .prepare(
        'INSERT INTO task_transitions(id, task_id, from_status, to_status, reason, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(makeId('ttr'), taskId, from, to, reason, actor, tx.now());
  }

  private tasksForProject(db: DatabaseSync, projectId: string): WorkTask[] {
    const rows = db
      .prepare('SELECT id FROM tasks WHERE project_id = ? ORDER BY ordinal ASC, created_at ASC, id ASC')
      .all(projectId) as Array<{ id: string }>;
    return rows.map((row) => this.loadTask(db, row.id)).filter((task): task is WorkTask => task !== null);
  }

  private selectNext(tasks: readonly WorkTask[], projectPath: string, owner: ExecutionOwner): WorkTask | null {
    const statuses = new Map(tasks.map((task) => [task.id, task.status] as const));
    const candidates = tasks
      .filter((task) => task.executionOwner === owner)
      .filter((task) => this.eligibilityFor(task, projectPath, statuses, owner).eligible);
    const ranked = [...candidates].sort((left, right) => {
      const leftResume = left.status === 'interrupted' ? 0 : 1;
      const rightResume = right.status === 'interrupted' ? 0 : 1;
      if (leftResume !== rightResume) return leftResume - rightResume;
      if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
      const leftPrompt = left.promptId ?? '\uffff';
      const rightPrompt = right.promptId ?? '\uffff';
      if (leftPrompt !== rightPrompt) return leftPrompt.localeCompare(rightPrompt);
      if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt);
      return left.id.localeCompare(right.id);
    });
    return ranked[0] ?? null;
  }

  private eligibilityFor(
    task: WorkTask,
    projectPath: string,
    statuses: ReadonlyMap<string, TaskStatus>,
    dispatcherOwner: ExecutionOwner,
  ): TaskEligibility {
    const checks: EligibilityCheck[] = [];
    const activeStatus = task.status === 'pending' || task.status === 'interrupted';
    checks.push({
      name: 'status',
      ok: activeStatus,
      detail: activeStatus ? `${task.status} work may start` : `${task.status} work does not start`,
    });
    if (task.status === 'blocked') {
      checks.push({ name: 'blocked', ok: false, detail: task.blockedReason ?? 'task is blocked' });
    }
    if (task.status === 'completed' || task.status === 'skipped') {
      checks.push({ name: 'closed', ok: false, detail: `task is already ${task.status}` });
    }
    const unfinished = task.dependencies.filter((dependency) => statuses.get(dependency) !== 'completed');
    checks.push({
      name: 'prerequisites',
      ok: unfinished.length === 0,
      detail:
        unfinished.length === 0
          ? task.dependencies.length === 0
            ? 'no prerequisites'
            : `prerequisites completed: ${task.dependencies.join(', ')}`
          : `waiting on ${unfinished.join(', ')}`,
    });
    checks.push({
      name: 'owner',
      ok: task.executionOwner === dispatcherOwner,
      detail:
        task.executionOwner === dispatcherOwner
          ? `owned by ${task.executionOwner}`
          : `owned by ${task.executionOwner}; ${dispatcherOwner} must not schedule it`,
    });
    checks.push({
      name: 'workspace',
      ok: existsSync(projectPath),
      detail: existsSync(projectPath) ? `workspace exists at ${projectPath}` : `workspace is missing at ${projectPath}`,
    });
    const eligible = checks.every((check) => check.ok);
    const reason = eligible
      ? task.status === 'interrupted'
        ? 'interrupted work resumes before new work'
        : 'ready to start'
      : (checks.find((check) => !check.ok)?.detail ?? 'not eligible');
    return { taskId: task.id, eligible, reason, checks };
  }

  private dependencyStatus(db: DatabaseSync, task: WorkTask): { ok: boolean; reason: string } {
    const missing: string[] = [];
    const unfinished: string[] = [];
    for (const dependency of task.dependencies) {
      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(dependency) as
        { status?: string } | undefined;
      if (!row) missing.push(dependency);
      else if (row.status !== 'completed') unfinished.push(dependency);
    }
    if (missing.length > 0) return { ok: false, reason: `missing prerequisites: ${missing.join(', ')}` };
    if (unfinished.length > 0) return { ok: false, reason: `prerequisites not verified: ${unfinished.join(', ')}` };
    return { ok: true, reason: 'all prerequisites completed' };
  }

  private nextStep(task: WorkTask): TaskStep | null {
    const running = task.steps.find((step) => step.status === 'running');
    if (running) return running;
    return task.steps.find((step) => step.status === 'pending') ?? null;
  }

  private recordedStep(db: DatabaseSync, taskId: string): string | null {
    const running = db
      .prepare("SELECT id FROM task_steps WHERE task_id = ? AND status = 'running' ORDER BY position LIMIT 1")
      .get(taskId) as { id?: string } | undefined;
    if (running?.id) return running.id;
    const pending = db
      .prepare("SELECT id FROM task_steps WHERE task_id = ? AND status = 'pending' ORDER BY position LIMIT 1")
      .get(taskId) as { id?: string } | undefined;
    return pending?.id ?? null;
  }

  private stepGaps(task: WorkTask): string[] {
    return task.steps.filter((step) => step.status !== 'done').map((step) => `${step.title} is ${step.status}`);
  }

  private completionGaps(task: WorkTask): string[] {
    const required = task.criteria.filter((criterion) => criterion.required);
    const gaps: string[] = [];
    if (required.length === 0) gaps.push('no acceptance criteria are configured');
    for (const criterion of required) {
      if (criterion.satisfiedAt === null) gaps.push(`${criterion.description} is not satisfied`);
      if (criterion.evidenceId) {
        const evidence = task.evidence.find((entry) => entry.id === criterion.evidenceId);
        if (evidence?.stale) gaps.push(`${criterion.description} has stale evidence: ${evidence.staleReason}`);
        if (!evidence) gaps.push(`${criterion.description} points at missing evidence`);
      }
    }
    if (
      task.criteria.some(
        (criterion) => criterion.required && criterion.kind === 'human' && criterion.satisfiedAt === null,
      )
    ) {
      gaps.push('a human-only acceptance item is still open');
    }
    return [...new Set(gaps)];
  }

  private assertAcyclic(db: DatabaseSync, projectId: string): void {
    const rows = db
      .prepare(
        `SELECT d.task_id, d.depends_on FROM task_dependencies d
           JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?`,
      )
      .all(projectId) as Array<{ task_id: string; depends_on: string }>;
    const edges = new Map<string, string[]>();
    for (const row of rows) {
      const list = edges.get(row.task_id) ?? [];
      list.push(row.depends_on);
      edges.set(row.task_id, list);
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (node: string): void => {
      if (done.has(node)) return;
      if (visiting.has(node)) throw stateError('dependency_cycle', `dependency cycle detected at task ${node}`);
      visiting.add(node);
      for (const next of edges.get(node) ?? []) visit(next);
      visiting.delete(node);
      done.add(node);
    };
    for (const node of edges.keys()) visit(node);
  }

  private validatePlanGraph(db: DatabaseSync, plan: TaskPlan): void {
    const incoming = new Map<string, string[]>();
    for (const task of plan.tasks) {
      if (incoming.has(task.id)) throw stateError('invalid_request', `duplicate task id in plan: ${task.id}`);
      const existing = db.prepare('SELECT id FROM tasks WHERE id = ?').get(task.id) as { id?: string } | undefined;
      if (existing?.id) throw stateError('conflict', `task ${task.id} already exists; import is not a merge`);
      incoming.set(task.id, task.depends_on ?? []);
    }
    const existing = new Map<string, string[]>();
    const rows = db
      .prepare(
        `SELECT d.task_id, d.depends_on FROM task_dependencies d
           JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?`,
      )
      .all(plan.project_id) as Array<{ task_id: string; depends_on: string }>;
    for (const row of rows) {
      const list = existing.get(row.task_id) ?? [];
      list.push(row.depends_on);
      existing.set(row.task_id, list);
    }
    const edges = new Map<string, string[]>(existing);
    for (const [taskId, deps] of incoming) edges.set(taskId, deps);
    for (const task of plan.tasks) {
      for (const dependency of task.depends_on ?? []) {
        if (dependency === task.id) throw stateError('dependency_cycle', `task ${task.id} depends on itself`);
        if (incoming.has(dependency)) continue;
        const row = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(dependency) as
          { project_id: string } | undefined;
        if (!row) throw stateError('not_found', `plan prerequisite ${dependency} does not exist`);
        if (row.project_id !== plan.project_id) {
          throw stateError('invalid_request', `plan prerequisite ${dependency} belongs to another workspace`);
        }
      }
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (node: string): void => {
      if (done.has(node)) return;
      if (visiting.has(node)) throw stateError('dependency_cycle', `dependency cycle detected at task ${node}`);
      visiting.add(node);
      for (const next of edges.get(node) ?? []) visit(next);
      visiting.delete(node);
      done.add(node);
    };
    for (const node of edges.keys()) visit(node);
  }

  private buildPrompt(task: WorkTask, options: { enforce: boolean; limit?: number }): TaskPrompt {
    const sections: string[] = [];
    const lines: string[] = [];
    lines.push(`# Task: ${task.title}`);
    lines.push('');
    lines.push(`Task id: ${task.id}`);
    lines.push(`Execution owner: ${task.executionOwner}`);
    if (task.dependencies.length > 0) {
      lines.push(`Prerequisites completed: ${task.dependencies.join(', ')}`);
    }
    if (task.description.trim()) {
      lines.push('');
      lines.push('## Description');
      lines.push(task.description.trim());
    }
    if (task.promptText.trim()) {
      lines.push('');
      lines.push('## Prompt');
      lines.push(task.promptText.trim());
      sections.push('prompt');
    } else {
      lines.push('');
      lines.push('## Prompt');
      lines.push(task.title);
      sections.push('title');
    }
    if (task.steps.length > 0) {
      lines.push('');
      lines.push('## Steps');
      for (const step of task.steps) lines.push(`${step.position}. ${step.title}`);
      sections.push('steps');
    }
    if (task.criteria.length > 0) {
      lines.push('');
      lines.push('## Acceptance criteria');
      for (const criterion of task.criteria) {
        lines.push(`- [${criterion.kind}]${criterion.required ? '' : ' optional'} ${criterion.description}`);
      }
      sections.push('acceptance');
    }
    if (task.requirements.length > 0) {
      lines.push('');
      lines.push('## Requirements');
      for (const requirement of task.requirements) {
        lines.push(`- ${requirement.requirementId}${requirement.criterionId ? ` / ${requirement.criterionId}` : ''}`);
      }
      sections.push('requirements');
    }
    lines.push('');
    lines.push(
      'Do not claim this task complete. Completion is recorded only when the acceptance checks above are verified.',
    );
    const full = `${lines.join('\n')}\n`;
    const characters = full.length;
    const limit = options.limit ?? this.maxPromptChars;
    if (characters > limit) {
      if (options.enforce) {
        throw stateError(
          'oversize',
          `the task prompt is ${characters} characters; the dispatch limit is ${this.maxPromptChars}`,
          'Shorten the prompt or split the task; Mona does not silently drop context.',
        );
      }
      const cut = full.slice(0, limit);
      return {
        text: `${cut}\n[truncated: ${characters - limit} characters omitted]\n`,
        sha256: createHash('sha256').update(cut, 'utf8').digest('hex'),
        characters: cut.length,
        truncated: true,
        sections,
        documentsInjected: 0,
      };
    }
    return {
      text: full,
      sha256: createHash('sha256').update(full, 'utf8').digest('hex'),
      characters,
      truncated: false,
      sections,
      documentsInjected: 0,
    };
  }

  private evidencePath(
    projectRoot: string,
    candidate: string,
    options: { mustExist?: boolean } = {},
  ): { relativePath: string; absolutePath: string } {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      throw stateError('invalid_request', 'an evidence path is required');
    }
    if (isAbsolute(candidate) || /^[a-zA-Z]:/.test(candidate)) {
      throw stateError('invalid_request', 'evidence paths must be project-relative, not absolute');
    }
    const absolute = resolve(projectRoot, candidate);
    const rel = relative(projectRoot, absolute);
    if (rel.startsWith('..') || isAbsolute(rel) || rel === '') {
      throw stateError('invalid_request', 'an evidence path must stay inside the project workspace');
    }
    const relativePath = normalizeRelativePath(rel);
    if (options.mustExist !== false) {
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        throw stateError('not_found', `evidence file does not exist: ${relativePath}`);
      }
    }
    return { relativePath, absolutePath: absolute };
  }
}
