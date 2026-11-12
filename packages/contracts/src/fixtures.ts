/**
 * Labeled test fixtures for the contract boundary. They are test data only:
 * the renderer must never import this module as a production fallback for a
 * failed engine connection. `FIXTURE_MARKER` lets the build scan prove that.
 */
import type { CapabilityState } from './engine.js';
import type { ErrorResult } from './error.js';
import type { EngineEventEnvelope, UsageEvidence } from './events.js';
import type { ThreadId, TurnId } from './ids.js';

export const FIXTURE_MARKER = 'mona.fixture.test-only';

const THREAD = 'thr_0123456789abcdef0123456789abcdef' as ThreadId;
const TURN = 'turn_0123456789abcdef0123456789abcdef' as TurnId;

export type Fixture =
  | { marker: typeof FIXTURE_MARKER; label: string; description: string; kind: 'event'; value: unknown }
  | { marker: typeof FIXTURE_MARKER; label: string; description: string; kind: 'usage'; value: unknown }
  | { marker: typeof FIXTURE_MARKER; label: string; description: string; kind: 'capability'; value: unknown }
  | { marker: typeof FIXTURE_MARKER; label: string; description: string; kind: 'error'; value: unknown };

const event = (
  label: string,
  description: string,
  name: string,
  payload: unknown,
  turnId: TurnId | null = TURN,
): Fixture => ({
  marker: FIXTURE_MARKER,
  label,
  description,
  kind: 'event',
  value: {
    schemaVersion: 1,
    seq: 1,
    event: name,
    threadId: THREAD,
    turnId,
    itemId: null,
    payload,
  } satisfies EngineEventEnvelope,
});

const usage: UsageEvidence = {
  buckets: { inputMissTokens: 0, cacheHitTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  cost: { status: 'unknown', reason: 'provider did not report pricing for this turn' },
  complete: false,
  capturedAt: '2026-11-12T00:00:00.000Z',
  turnId: null,
};

const unsupported: CapabilityState = {
  status: 'unsupported',
  reason: 'terminal_stream is false on Codewhale 0.10.2 (ff466b2ed0bf)',
};
const blocked: ErrorResult = {
  code: 'outcome_unknown',
  message: 'The turn may have reached the engine; reconcile before resubmitting.',
  retryable: false,
};

export const FIXTURES: Fixture[] = [
  event('connecting', 'transport opening, no turn yet', 'thread.started', { thread: { id: THREAD } }, null),
  event('running', 'streaming assistant delta', 'item.delta', { itemId: 'item_1', delta: 'Working' }),
  event('completed', 'turn reached a terminal completed state', 'turn.completed', {
    status: 'completed',
    turnId: TURN,
    durationMs: 1200,
  }),
  event('interrupted', 'turn was interrupted, never reported as completed', 'turn.completed', {
    status: 'interrupted',
    turnId: TURN,
  }),
  {
    marker: FIXTURE_MARKER,
    label: 'unknown-cost',
    description: 'cost is unknown, never zero',
    kind: 'usage',
    value: usage,
  },
  event('blocked', 'engine reports an unreconciled outcome', 'task.blocked', blocked),
  {
    marker: FIXTURE_MARKER,
    label: 'unsupported',
    description: 'capability false on this build',
    kind: 'capability',
    value: unsupported,
  },
  event('malformed', 'invalid thread id and negative seq must be rejected', 'item.delta', { delta: 'x' }),
];

// The malformed fixture is intentionally outside the envelope contract.
const malformedValue = FIXTURES.find((fixture) => fixture.label === 'malformed')!.value as Record<string, unknown>;
export const MALFORMED_FIXTURE: unknown = {
  ...malformedValue,
  schemaVersion: 1,
  seq: -1,
  threadId: 'not-a-thread-id',
};
