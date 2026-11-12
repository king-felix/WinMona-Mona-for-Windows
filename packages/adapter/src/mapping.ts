import { z } from 'zod';
import {
  UsageEvidence,
  UpstreamThread,
  UpstreamTurn,
  toEffectiveProfile,
  type EffectiveProfile,
  type UsageEvidence as UsageEvidenceType,
} from '@mona/contracts';
import { fail, ok, type Result } from './errors.js';

export const ThreadEnvelope = z
  .object({
    thread: UpstreamThread,
    turns: z.array(UpstreamTurn).optional(),
    latest_seq: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const TurnSubmitWire = z
  .object({
    thread: UpstreamThread,
    turn: UpstreamTurn,
    idempotent_replay: z.boolean().optional(),
  })
  .passthrough();

export const HistoryWire = z
  .object({
    runtime_thread_id: z.string().min(1),
    session: z
      .object({
        messages: z.array(z.unknown()),
      })
      .passthrough()
      .optional(),
    document_digest: z.string().optional(),
  })
  .passthrough();

const Totals = z
  .object({
    input_tokens: z.number().int().nonnegative().default(0),
    output_tokens: z.number().int().nonnegative().default(0),
    cached_tokens: z.number().int().nonnegative().default(0),
    reasoning_tokens: z.number().int().nonnegative().default(0),
    cost_usd: z.number().nonnegative().nullable().optional(),
    cost_complete: z.boolean().optional(),
    unpriced_turns: z.number().int().nonnegative().optional(),
    unpriced_reasons: z.array(z.string()).optional(),
    pricing_provenances: z.array(z.string()).optional(),
    turns: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const ThreadUsageWire = z
  .object({
    thread_id: z.string().min(1),
    totals: Totals,
  })
  .passthrough();

export function mapEffectiveProfile(rawThread: unknown, observedAt: string): Result<EffectiveProfile> {
  try {
    return ok(toEffectiveProfile(rawThread, observedAt));
  } catch (error) {
    return fail('schema_drift', 'runtime thread did not match the effective-profile contract', {
      detail: error instanceof Error ? error.message.slice(0, 500) : undefined,
    });
  }
}

export function verifyThreadId(actual: string, expected: string): Result<string> {
  if (actual !== expected) {
    return fail('thread_mismatch', 'runtime answered for a different thread', {
      detail: `expected ${expected}, received ${actual}`,
    });
  }
  return ok(actual);
}

export function mapUsage(raw: unknown, capturedAt: string): Result<UsageEvidenceType> {
  const parsed = ThreadUsageWire.safeParse(raw);
  if (!parsed.success) {
    return fail('schema_drift', 'runtime usage did not match the expected contract', {
      detail: parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')
        .slice(0, 500),
    });
  }
  const wire = parsed.data;
  const totals = wire.totals;
  const provenance = totals.pricing_provenances?.filter(Boolean) ?? [];
  const priced =
    totals.cost_complete === true && (totals.unpriced_turns ?? 0) === 0 && typeof totals.cost_usd === 'number';
  const cost = priced
    ? {
        status: 'known' as const,
        usd: totals.cost_usd as number,
        source: 'engine_priced' as const,
        rateRevision: provenance.length ? provenance.join('+') : 'engine-bundled',
      }
    : {
        status: 'unknown' as const,
        reason: totals.unpriced_reasons?.join('; ') || 'engine did not report complete pricing for this thread',
      };
  try {
    return ok(
      UsageEvidence.parse({
        buckets: {
          inputMissTokens: totals.input_tokens,
          cacheHitTokens: totals.cached_tokens,
          outputTokens: totals.output_tokens,
          reasoningTokens: totals.reasoning_tokens,
        },
        cost,
        complete: priced,
        capturedAt,
        turnId: null,
      }),
    );
  } catch (error) {
    return fail('schema_drift', 'mapped usage failed Mona validation', {
      detail: error instanceof Error ? error.message.slice(0, 500) : undefined,
    });
  }
}
