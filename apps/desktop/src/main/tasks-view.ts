import type { TaskBoard, TaskStatus, WorkTask } from '@mona/project-state';
import type { TaskBoardView, TaskCardView, TaskStatusView } from '../shared/tasks.js';

/**
 * Projection from the task service's board to the renderer's vocabulary.
 *
 * The board is the authority: eligibility, the next task, steps, criteria and
 * dependency edges are copied, not recomputed here. Recomputing them in the view
 * would create a second scheduler, which this product deliberately does not have.
 */
const STATUSES: readonly TaskStatusView[] = [
  'pending',
  'running',
  'verifying',
  'completed',
  'blocked',
  'interrupted',
  'skipped',
];

function statusView(status: TaskStatus): TaskStatusView {
  return status;
}

function cardView(task: WorkTask, entry: TaskBoard['tasks'][number] | undefined): TaskCardView {
  return {
    id: task.id,
    title: task.title,
    status: statusView(task.status),
    description: task.description,
    owner: task.executionOwner,
    ordinal: task.ordinal,
    currentStep: task.currentStep,
    blockedReason: task.blockedReason,
    skippedReason: task.skippedReason,
    steps: task.steps.map((step) => ({
      id: step.id,
      position: step.position,
      title: step.title,
      status: step.status,
      detail: step.detail,
    })),
    criteria: task.criteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      kind: criterion.kind,
      required: criterion.required,
      satisfied: criterion.satisfiedAt !== null,
      note: criterion.satisfiedNote,
    })),
    evidence: task.evidence.map((item) => ({
      id: item.id,
      criterionId: item.criterionId,
      path: item.path,
      sha256: item.sha256,
      note: item.note,
      recordedAt: item.recordedAt,
      stale: item.stale,
    })),
    dependencies: [...task.dependencies],
    dependents: [...task.dependents],
    requirementRefs: task.requirements.map((ref) =>
      ref.criterionId ? `${ref.requirementId}/${ref.criterionId}` : ref.requirementId,
    ),
    eligible: entry?.eligibility.eligible ?? false,
    eligibilityReason: entry?.eligibility.reason ?? 'The task service did not report eligibility for this task.',
    blockedByProblemIds: entry ? [...entry.eligibility.blockedByProblemIds] : [],
    updatedAt: task.updatedAt,
  };
}

export function toTaskBoardView(board: TaskBoard): TaskBoardView {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<TaskStatusView, number>;
  const byId = new Map(board.tasks.map((entry) => [entry.task.id, entry]));
  const tasks = [...board.tasks]
    .sort(
      (left, right) =>
        left.task.ordinal - right.task.ordinal || left.task.createdAt.localeCompare(right.task.createdAt),
    )
    .map((entry) => {
      counts[statusView(entry.task.status)] += 1;
      return cardView(entry.task, byId.get(entry.task.id));
    });
  return {
    projectId: board.projectId,
    generatedAt: board.generatedAt,
    tasks,
    eligible: [...board.eligible],
    next: board.next,
    counts,
  };
}
