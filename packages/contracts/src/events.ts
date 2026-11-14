import { z } from 'zod';
import { ThreadId, TurnId } from './ids.js';

const Timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid ISO timestamp');
const TokenCount = z.number().int().nonnegative();

/**
 * Token buckets as reported by the engine. `inputMissTokens` excludes cached
 * input; `cacheHitTokens` is disjoint. Reasoning tokens are already included in
 * `outputTokens` on the pinned deepseek route (D-0014) and are informational.
 */
export const UsageBuckets = z
  .object({
    inputMissTokens: TokenCount,
    cacheHitTokens: TokenCount,
    outputTokens: TokenCount,
    reasoningTokens: TokenCount,
  })
  .strict();
export type UsageBuckets = z.infer<typeof UsageBuckets>;

/**
 * Cost is either known with a source, or explicitly unknown. A missing cost is
 * never coerced to zero.
 */
export const CostEvidence = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('known'),
      usd: z.number().nonnegative(),
      source: z.enum(['provider_reported', 'engine_priced', 'local_estimate']),
      rateRevision: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('unknown'),
      reason: z.string().min(1),
    })
    .strict(),
]);
export type CostEvidence = z.infer<typeof CostEvidence>;

export const UsageEvidence = z
  .object({
    buckets: UsageBuckets,
    cost: CostEvidence,
    complete: z.boolean(),
    capturedAt: Timestamp,
    turnId: TurnId.nullable(),
  })
  .strict();
export type UsageEvidence = z.infer<typeof UsageEvidence>;

/**
 * Known engine payloads. Unknown event names stay inspectable through
 * EngineEventEnvelope rather than crashing the client.
 */
export const TurnCompletedPayload = z.union([
  z
    .object({
      turn: z
        .object({
          id: z.string().min(1),
          thread_id: z.string().min(1),
          status: z.enum(['completed', 'interrupted', 'failed', 'canceled']),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      status: z.enum(['completed', 'interrupted', 'failed', 'canceled']),
      turnId: TurnId.optional(),
      durationMs: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);
export type TurnCompletedPayload = z.infer<typeof TurnCompletedPayload>;

export const ItemDeltaPayload = z
  .object({
    itemId: z.string().min(1).nullable().optional(),
    delta: z.string(),
  })
  .passthrough();
export type ItemDeltaPayload = z.infer<typeof ItemDeltaPayload>;

/**
 * An approval request as the pinned runtime actually sends it. The engine's own
 * client reads `approval_id`, `tool_name`, `description`, `summary` and
 * `intent_summary` straight off the event payload, so those snake_case names are
 * the wire truth; camelCase is accepted because the earlier contract used it.
 * Everything else is preserved rather than dropped.
 */
export const ApprovalRequiredPayload = z
  .object({
    approval_id: z.string().min(1).optional(),
    approvalId: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    tool_name: z.string().min(1).optional(),
    toolName: z.string().min(1).optional(),
    description: z.string().optional(),
    summary: z.string().optional(),
    intent_summary: z.string().optional(),
    turn_id: z.string().min(1).optional(),
  })
  .passthrough();
export type ApprovalRequiredPayload = z.infer<typeof ApprovalRequiredPayload>;

/**
 * One clarification question as the runtime shapes it. `options` are the only
 * values the runtime accepts for a selection; a free-text answer stays reachable
 * because the engine's own client always offers it.
 */
export const UserInputQuestion = z
  .object({
    id: z.string().min(1),
    header: z.string().optional(),
    question: z.string().optional(),
    multi_select: z.boolean().optional(),
    options: z
      .array(z.object({ label: z.string().min(1), description: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();
export type UserInputQuestion = z.infer<typeof UserInputQuestion>;

/**
 * A pending clarification. The engine's client reads `payload.request.questions`;
 * `request_id`/`input_id` identify the request that must be answered.
 */
export const UserInputRequiredPayload = z
  .object({
    request_id: z.string().min(1).optional(),
    input_id: z.string().min(1).optional(),
    requestId: z.string().min(1).optional(),
    request: z
      .object({ questions: z.array(UserInputQuestion) })
      .passthrough()
      .optional(),
    questions: z.array(UserInputQuestion).optional(),
    turn_id: z.string().min(1).optional(),
  })
  .passthrough();
export type UserInputRequiredPayload = z.infer<typeof UserInputRequiredPayload>;

/**
 * The answer the engine accepted for a clarification: one entry per selected
 * option, or an `Other` entry carrying free text.
 */
export const UserInputAnswer = z.object({ id: z.string().min(1), label: z.string(), value: z.string() }).strict();
export type UserInputAnswer = z.infer<typeof UserInputAnswer>;

/** Terminal events for a human request. Payload shapes are read permissively. */
export const HumanRequestSettledPayload = z
  .object({
    approval_id: z.string().min(1).optional(),
    approvalId: z.string().min(1).optional(),
    request_id: z.string().min(1).optional(),
    decision: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();
export type HumanRequestSettledPayload = z.infer<typeof HumanRequestSettledPayload>;

export const StreamEndPayload = z
  .object({
    lastSeq: z.number().int().nonnegative(),
    retryable: z.boolean(),
    reason: z.string().min(1),
  })
  .strict();
export type StreamEndPayload = z.infer<typeof StreamEndPayload>;

export const EngineEventEnvelope = z
  .object({
    schemaVersion: z.literal(1),
    seq: z.number().int().nonnegative(),
    event: z.string().min(1),
    threadId: ThreadId,
    turnId: TurnId.nullable(),
    itemId: z.string().min(1).nullable(),
    payload: z.unknown(),
  })
  .strict();
export type EngineEventEnvelope = z.infer<typeof EngineEventEnvelope>;

export const KNOWN_EVENTS = {
  'turn.completed': TurnCompletedPayload,
  'item.delta': ItemDeltaPayload,
  'approval.required': ApprovalRequiredPayload,
  'approval.decided': HumanRequestSettledPayload,
  'approval.timeout': HumanRequestSettledPayload,
  'user_input.required': UserInputRequiredPayload,
  'user_input.answered': HumanRequestSettledPayload,
  'user_input.canceled': HumanRequestSettledPayload,
  'stream.end': StreamEndPayload,
} as const;

export type KnownEventName = keyof typeof KNOWN_EVENTS;

export type ParsedEngineEvent =
  | {
      kind: 'known';
      name: KnownEventName;
      envelope: EngineEventEnvelope;
      payload: z.infer<(typeof KNOWN_EVENTS)[KnownEventName]>;
    }
  | { kind: 'unknown'; name: string; envelope: EngineEventEnvelope };

/**
 * Parse a projected engine event. Unknown event names are preserved for
 * diagnostics; a known name with a malformed payload is rejected so a broken
 * client cannot silently render wrong state.
 */
export function parseEngineEvent(
  input: unknown,
): { ok: true; event: ParsedEngineEvent } | { ok: false; error: string } {
  const envelope = EngineEventEnvelope.safeParse(input);
  if (!envelope.success) return { ok: false, error: envelope.error.issues.map((issue) => issue.message).join('; ') };
  const schema = KNOWN_EVENTS[envelope.data.event as KnownEventName];
  if (!schema) return { ok: true, event: { kind: 'unknown', name: envelope.data.event, envelope: envelope.data } };
  const payload = schema.safeParse(envelope.data.payload);
  if (!payload.success) return { ok: false, error: payload.error.issues.map((issue) => issue.message).join('; ') };
  return {
    ok: true,
    event: {
      kind: 'known',
      name: envelope.data.event as KnownEventName,
      envelope: envelope.data,
      payload: payload.data as z.infer<(typeof KNOWN_EVENTS)[KnownEventName]>,
    },
  };
}

/**
 * Read an approval request from either wire spelling. Returns null when the
 * payload carries no usable identity, so the caller can report the gap instead
 * of inventing an id it cannot answer.
 */
export function normalizeApprovalRequired(payload: unknown): {
  approvalId: string;
  toolName: string;
  description: string;
  intentSummary: string | null;
} | null {
  const parsed = ApprovalRequiredPayload.safeParse(payload);
  if (!parsed.success) return null;
  const data = parsed.data;
  const approvalId = data.approval_id ?? data.approvalId ?? data.id ?? '';
  if (!approvalId) return null;
  return {
    approvalId,
    toolName: data.tool_name ?? data.toolName ?? 'unknown',
    description: data.description ?? data.summary ?? 'The runtime is waiting for approval to continue.',
    intentSummary: data.intent_summary ?? null,
  };
}

/** Read a clarification request, accepting both payload placements the engine uses. */
export function normalizeUserInputRequired(payload: unknown): {
  requestId: string;
  questions: UserInputQuestion[];
} | null {
  const parsed = UserInputRequiredPayload.safeParse(payload);
  if (!parsed.success) return null;
  const data = parsed.data;
  const requestId = data.request_id ?? data.input_id ?? data.requestId ?? '';
  const questions = data.request?.questions ?? data.questions ?? [];
  if (!requestId || questions.length === 0) return null;
  return { requestId, questions };
}
