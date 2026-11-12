import { z } from 'zod';
import { EffectiveProfile, PermissionPosture } from './engine.js';
import type { EngineMode } from './engine.js';
import { EngineEventEnvelope } from './events.js';
import { ThreadId, TurnId } from './ids.js';

/**
 * Upstream wire shapes, validated loosely and kept separate from Mona's types.
 * Upstream adds fields between releases; `.passthrough()` preserves them for
 * diagnostics without leaking raw response shapes into UI code.
 */
export const UpstreamThread = z
  .object({
    schema_version: z.number().int().positive(),
    id: z.string().min(1),
    model: z.string().min(1),
    model_provider: z.string().min(1),
    model_provider_id: z.string().min(1).optional(),
    workspace: z.string().min(1),
    mode: z.string().min(1),
    permission_posture: z.string().min(1),
    allow_shell: z.boolean(),
    trust_mode: z.boolean(),
    auto_approve: z.boolean(),
    archived: z.boolean().optional(),
  })
  .passthrough();
export type UpstreamThread = z.infer<typeof UpstreamThread>;

export const UpstreamTurn = z
  .object({
    schema_version: z.number().int().positive(),
    id: z.string().min(1),
    thread_id: z.string().min(1),
    status: z.string().min(1),
    effective_provider: z.string().min(1).optional(),
    effective_model: z.string().min(1).optional(),
    permission_posture: z.string().min(1).optional(),
  })
  .passthrough();
export type UpstreamTurn = z.infer<typeof UpstreamTurn>;

export const UpstreamEventFrame = z
  .object({
    schema_version: z.number().int().positive(),
    seq: z.number().int().nonnegative(),
    event: z.string().min(1),
    thread_id: z.string().min(1),
    turn_id: z.string().min(1).nullable().optional(),
    item_id: z.string().min(1).nullable().optional(),
    payload: z.unknown(),
  })
  .passthrough();
export type UpstreamEventFrame = z.infer<typeof UpstreamEventFrame>;

function posture(value: string): PermissionPosture {
  return PermissionPosture.safeParse(value).success ? (value as PermissionPosture) : 'unknown';
}

function mode(value: string): z.infer<typeof EngineMode> {
  return value === 'plan' ? 'plan' : 'agent';
}

/**
 * Maps an observed upstream thread into Mona's effective profile. Throws on an
 * id that does not match the observed thread shape rather than coercing it.
 */
export function toEffectiveProfile(thread: unknown, observedAt = new Date().toISOString()): EffectiveProfile {
  const parsed = UpstreamThread.parse(thread);
  return EffectiveProfile.parse({
    threadId: ThreadId.parse(parsed.id),
    workspace: parsed.workspace,
    provider: parsed.model_provider,
    model: parsed.model,
    mode: mode(parsed.mode),
    permissionPosture: posture(parsed.permission_posture),
    allowShell: parsed.allow_shell,
    trustMode: parsed.trust_mode,
    autoApprove: parsed.auto_approve,
    observedAt,
  });
}

/** Maps one SSE frame into Mona's envelope. Unknown event names are preserved. */
export function toEventEnvelope(frame: unknown): EngineEventEnvelope {
  const parsed = UpstreamEventFrame.parse(frame);
  return EngineEventEnvelope.parse({
    schemaVersion: 1,
    seq: parsed.seq,
    event: parsed.event,
    threadId: ThreadId.parse(parsed.thread_id),
    turnId: parsed.turn_id ? TurnId.parse(parsed.turn_id) : null,
    itemId: parsed.item_id ?? null,
    payload: parsed.payload,
  });
}
