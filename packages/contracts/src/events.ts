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

export const ApprovalRequiredPayload = z
  .object({
    approvalId: z.string().min(1),
    toolName: z.string().min(1),
    description: z.string().optional(),
  })
  .passthrough();
export type ApprovalRequiredPayload = z.infer<typeof ApprovalRequiredPayload>;

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
