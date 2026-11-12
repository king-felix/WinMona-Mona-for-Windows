import { z } from 'zod';
import { OperationKey, ProjectId, SubmissionId, TaskId, ThreadId, TurnId } from './ids.js';

const Timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid ISO timestamp');

export const SubmissionState = z.enum([
  'intent_persisted',
  'sent',
  'accepted',
  'outcome_unknown',
  'completed',
  'interrupted',
  'failed',
  'canceled',
]);
export type SubmissionState = z.infer<typeof SubmissionState>;

const ALLOWED: Record<SubmissionState, readonly SubmissionState[]> = {
  intent_persisted: ['sent', 'failed', 'canceled'],
  sent: ['accepted', 'outcome_unknown', 'failed', 'canceled'],
  accepted: ['completed', 'interrupted', 'failed', 'outcome_unknown'],
  outcome_unknown: ['completed', 'interrupted', 'failed', 'canceled'],
  completed: [],
  interrupted: [],
  failed: [],
  canceled: [],
};

export function canTransitionSubmission(from: SubmissionState, to: SubmissionState): boolean {
  return ALLOWED[from].includes(to);
}

export const Reconciliation = z
  .object({
    required: z.boolean(),
    guidance: z.string().min(1).optional(),
  })
  .strict();
export type Reconciliation = z.infer<typeof Reconciliation>;

/**
 * A submission is persisted before any request leaves Mona. `outcome_unknown`
 * means the request may have reached the engine; it must never trigger a blind
 * resubmission.
 */
export const SubmissionRecord = z
  .object({
    id: SubmissionId,
    projectId: ProjectId,
    taskId: TaskId.nullable(),
    threadId: ThreadId,
    turnId: TurnId.nullable(),
    operationKey: OperationKey,
    state: SubmissionState,
    intentPersistedAt: Timestamp,
    dispatchedAt: Timestamp.nullable(),
    lastObservedAt: Timestamp,
    reconciliation: Reconciliation,
  })
  .strict();
export type SubmissionRecord = z.infer<typeof SubmissionRecord>;

export const SubmissionTransition = z
  .object({
    from: SubmissionState,
    to: SubmissionState,
    at: Timestamp,
    note: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => canTransitionSubmission(value.from, value.to), {
    message: 'illegal submission state transition',
  });
export type SubmissionTransition = z.infer<typeof SubmissionTransition>;
