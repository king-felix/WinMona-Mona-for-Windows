import type { IpcResult } from './catalog.js';

/**
 * Renderer-facing work-board vocabulary. A task shown here exists in the product
 * database: its steps, acceptance criteria, dependency edges and eligibility were
 * read from the task service, not summarised or guessed. Eligibility is reported
 * with its reason, so "not eligible" is never an unexplained grey button.
 */
export const TASK_CHANNELS = {
  board: 'mona:task-board',
  create: 'mona:task-create',
} as const;

export type TaskStatusView = 'pending' | 'running' | 'verifying' | 'completed' | 'blocked' | 'interrupted' | 'skipped';

export type TaskExecutionOwnerView = 'mona_queue' | 'native_workflow';

export type TaskStepView = {
  id: string;
  position: number;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail: string | null;
};

export type TaskCriterionView = {
  id: string;
  description: string;
  kind: 'check' | 'human';
  required: boolean;
  satisfied: boolean;
  note: string | null;
};

export type TaskEvidenceView = {
  id: string;
  criterionId: string | null;
  path: string;
  sha256: string;
  note: string | null;
  recordedAt: string;
  stale: boolean;
};

export type TaskCardView = {
  id: string;
  title: string;
  status: TaskStatusView;
  description: string;
  owner: TaskExecutionOwnerView;
  ordinal: number;
  currentStep: string | null;
  blockedReason: string | null;
  skippedReason: string | null;
  steps: TaskStepView[];
  criteria: TaskCriterionView[];
  evidence: TaskEvidenceView[];
  dependencies: string[];
  dependents: string[];
  requirementRefs: string[];
  /** From the task service's own eligibility pass, with its stated reason. */
  eligible: boolean;
  eligibilityReason: string;
  blockedByProblemIds: string[];
  updatedAt: string;
};

export type TaskBoardView = {
  projectId: string;
  generatedAt: string;
  tasks: TaskCardView[];
  /** Task ids eligible right now, in the service's deterministic order. */
  eligible: string[];
  /** The single task the queue would run next, or null. */
  next: string | null;
  counts: Record<TaskStatusView, number>;
};

export type TaskCreateView = {
  projectId: string;
  title: string;
  description?: string;
  promptText?: string;
  owner: TaskExecutionOwnerView;
  steps?: string[];
  criteria?: string[];
  dependsOn?: string[];
};

export type TaskBridge = {
  taskBoard(input: { projectId: string }): Promise<IpcResult<TaskBoardView>>;
  /** Creates a pending task. It starts nothing; execution still goes through Studio. */
  taskCreate(input: TaskCreateView): Promise<IpcResult<TaskBoardView>>;
};
