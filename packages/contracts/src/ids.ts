import { z } from 'zod';

/**
 * Opaque identities at Mona's boundary. Upstream Codewhale ids are treated as
 * opaque strings: the adapter validates their observed shape but never parses
 * meaning out of them. Brands make accidental project/thread/turn substitution
 * a type error as well as a runtime error.
 */
const HEX32 = /^[0-9a-f]{32}$/;

export const ProjectId = z
  .string()
  .regex(/^prj_[0-9a-f]{32}$/, 'project id must be prj_ followed by 32 lowercase hex characters')
  .brand<'ProjectId'>();
export type ProjectId = z.infer<typeof ProjectId>;

export const TaskId = z
  .string()
  .regex(/^tsk_[0-9a-f]{32}$/, 'task id must be tsk_ followed by 32 lowercase hex characters')
  .brand<'TaskId'>();
export type TaskId = z.infer<typeof TaskId>;

export const AttemptId = z
  .string()
  .regex(/^att_[0-9a-f]{32}$/, 'attempt id must be att_ followed by 32 lowercase hex characters')
  .brand<'AttemptId'>();
export type AttemptId = z.infer<typeof AttemptId>;

export const SubmissionId = z
  .string()
  .regex(/^sub_[0-9a-f]{32}$/, 'submission id must be sub_ followed by 32 lowercase hex characters')
  .brand<'SubmissionId'>();
export type SubmissionId = z.infer<typeof SubmissionId>;

export const ThreadId = z
  .string()
  .regex(/^thr_[0-9a-f]{32}$/, 'thread id must be thr_ followed by 32 lowercase hex characters')
  .brand<'ThreadId'>();
export type ThreadId = z.infer<typeof ThreadId>;

export const TurnId = z
  .string()
  .regex(/^turn_[0-9a-f]{32}$/, 'turn id must be turn_ followed by 32 lowercase hex characters')
  .brand<'TurnId'>();
export type TurnId = z.infer<typeof TurnId>;

export const CapabilityId = z
  .string()
  .regex(/^CAP-\d{4}$/, 'capability id must be CAP- followed by four digits')
  .brand<'CapabilityId'>();
export type CapabilityId = z.infer<typeof CapabilityId>;

export const OperationKey = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/, 'operation key must be 8-128 URL-safe characters')
  .brand<'OperationKey'>();
export type OperationKey = z.infer<typeof OperationKey>;

function uuidHex(): string {
  return globalThis.crypto.randomUUID().replaceAll('-', '');
}

export function newProjectId(): ProjectId {
  return ProjectId.parse(`prj_${uuidHex()}`);
}
export function newTaskId(): TaskId {
  return TaskId.parse(`tsk_${uuidHex()}`);
}
export function newAttemptId(): AttemptId {
  return AttemptId.parse(`att_${uuidHex()}`);
}
export function newSubmissionId(): SubmissionId {
  return SubmissionId.parse(`sub_${uuidHex()}`);
}
export function newOperationKey(prefix = 'op'): OperationKey {
  return OperationKey.parse(`${prefix}-${uuidHex()}`);
}

/** Validates that an upstream id matches the observed shape without branding it as another kind. */
export function isUpstreamHexId(value: string): boolean {
  return HEX32.test(value.replace(/^(thr_|turn_)/, ''));
}
