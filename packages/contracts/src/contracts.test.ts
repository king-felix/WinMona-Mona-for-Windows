import { describe, expect, it } from 'vitest';
import {
  ApprovalRequiredPayload,
  normalizeApprovalRequired,
  normalizeUserInputRequired,
  CapabilityId,
  CostEvidence,
  EngineCapabilities,
  EngineEventEnvelope,
  ErrorResult,
  FIXTURES,
  MALFORMED_FIXTURE,
  OperationKey,
  ProjectId,
  SubmissionRecord,
  SubmissionState,
  SubmissionTransition,
  TaskId,
  ThreadId,
  TurnId,
  UsageEvidence,
  canTransitionSubmission,
  errorResult,
  newOperationKey,
  newProjectId,
  parseEngineEvent,
  toEffectiveProfile,
  toEventEnvelope,
  UpstreamThread,
} from './index.js';

const THREAD = 'thr_0123456789abcdef0123456789abcdef';
const TURN = 'turn_0123456789abcdef0123456789abcdef';

describe('opaque identities', () => {
  it('accepts correctly prefixed ids', () => {
    expect(ProjectId.parse('prj_0123456789abcdef0123456789abcdef')).toBeTruthy();
    expect(TaskId.parse('tsk_0123456789abcdef0123456789abcdef')).toBeTruthy();
    expect(ThreadId.parse(THREAD)).toBeTruthy();
    expect(TurnId.parse(TURN)).toBeTruthy();
    expect(CapabilityId.parse('CAP-0001')).toBeTruthy();
  });

  it('rejects a thread id used as a project id and vice versa', () => {
    expect(() => ProjectId.parse(THREAD)).toThrow();
    expect(() => ThreadId.parse('prj_0123456789abcdef0123456789abcdef')).toThrow();
    expect(() => TurnId.parse(THREAD)).toThrow();
  });

  it('generates valid ids and operation keys', () => {
    expect(ProjectId.safeParse(newProjectId()).success).toBe(true);
    expect(OperationKey.safeParse(newOperationKey()).success).toBe(true);
    expect(OperationKey.safeParse('short').success).toBe(false);
  });
});

describe('unknown-field policy', () => {
  it('rejects unknown fields on internal contracts', () => {
    const result = ErrorResult.safeParse({
      code: 'internal',
      message: 'boom',
      retryable: false,
      secret: 'leak',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields on the event envelope', () => {
    const result = EngineEventEnvelope.safeParse({
      schemaVersion: 1,
      seq: 1,
      event: 'item.delta',
      threadId: THREAD,
      turnId: TURN,
      itemId: null,
      payload: { delta: 'x' },
      injected: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a capability record with a missing flag instead of defaulting it', () => {
    expect(
      EngineCapabilities.safeParse({
        threads: true,
        turns: true,
      }).success,
    ).toBe(false);
  });
});

describe('engine events', () => {
  it('parses a known event with a valid payload', () => {
    const result = parseEngineEvent({
      schemaVersion: 1,
      seq: 4,
      event: 'turn.completed',
      threadId: THREAD,
      turnId: TURN,
      itemId: null,
      payload: { status: 'completed', turnId: TURN, durationMs: 10 },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.event.kind === 'known') {
      expect(result.event.name).toBe('turn.completed');
    }
  });

  it('preserves an unknown event for diagnostics', () => {
    const result = parseEngineEvent({
      schemaVersion: 1,
      seq: 5,
      event: 'model.tools.snapshot',
      threadId: THREAD,
      turnId: null,
      itemId: null,
      payload: { tool_count: 15 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.kind).toBe('unknown');
  });

  it('rejects a known event with a malformed payload', () => {
    const result = parseEngineEvent({
      schemaVersion: 1,
      seq: 6,
      event: 'turn.completed',
      threadId: THREAD,
      turnId: TURN,
      itemId: null,
      payload: { status: 'done' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects the deliberately malformed fixture', () => {
    expect(parseEngineEvent(MALFORMED_FIXTURE).ok).toBe(false);
  });

  it('validates every non-malformed event fixture', () => {
    for (const fixture of FIXTURES) {
      if (fixture.kind !== 'event' || fixture.label === 'malformed') continue;
      const result = parseEngineEvent(fixture.value);
      expect(result.ok, `fixture ${fixture.label}`).toBe(true);
    }
  });

  it('maps upstream snake_case frames into the Mona envelope', () => {
    const envelope = toEventEnvelope({
      schema_version: 1,
      seq: 7,
      event: 'turn.completed',
      thread_id: THREAD,
      turn_id: TURN,
      item_id: null,
      payload: { status: 'interrupted', turn_id: TURN },
      timestamp: '2026-11-12T00:00:00Z',
    });
    expect(envelope.threadId).toBe(THREAD);
    expect(envelope.turnId).toBe(TURN);
  });
});

describe('usage and cost', () => {
  it('keeps unknown cost explicitly unknown, never zero', () => {
    const parsed = UsageEvidence.parse({
      buckets: { inputMissTokens: 10, cacheHitTokens: 0, outputTokens: 2, reasoningTokens: 0 },
      cost: { status: 'unknown', reason: 'no pricing reported' },
      complete: false,
      capturedAt: '2026-11-12T00:00:00Z',
      turnId: null,
    });
    expect(parsed.cost.status).toBe('unknown');
    if (parsed.cost.status === 'unknown') expect(parsed.cost.reason).toBe('no pricing reported');
  });

  it('requires a source and rate revision for known cost', () => {
    expect(CostEvidence.safeParse({ status: 'known', usd: 0.1 }).success).toBe(false);
    expect(
      CostEvidence.safeParse({ status: 'known', usd: 0.1, source: 'engine_priced', rateRevision: '2026-11-12' })
        .success,
    ).toBe(true);
  });
});

describe('submission safety', () => {
  it('allows the forward path and blocks illegal transitions', () => {
    expect(canTransitionSubmission('intent_persisted', 'sent')).toBe(true);
    expect(canTransitionSubmission('sent', 'outcome_unknown')).toBe(true);
    expect(canTransitionSubmission('outcome_unknown', 'completed')).toBe(true);
    expect(canTransitionSubmission('completed', 'sent')).toBe(false);
    expect(canTransitionSubmission('intent_persisted', 'completed')).toBe(false);
  });

  it('rejects an illegal persisted transition', () => {
    expect(
      SubmissionTransition.safeParse({
        from: 'completed',
        to: 'sent',
        at: '2026-11-12T00:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('records outcome_unknown with reconciliation guidance', () => {
    const record = SubmissionRecord.parse({
      id: 'sub_0123456789abcdef0123456789abcdef',
      projectId: 'prj_0123456789abcdef0123456789abcdef',
      taskId: null,
      threadId: THREAD,
      turnId: null,
      operationKey: 'op-0123456789abcdef0123456789abcdef',
      state: 'outcome_unknown',
      intentPersistedAt: '2026-11-12T00:00:00Z',
      dispatchedAt: '2026-11-12T00:00:01Z',
      lastObservedAt: '2026-11-12T00:00:02Z',
      reconciliation: { required: true, guidance: 'Reopen the thread and inspect history before resubmitting.' },
    });
    expect(record.state).toBe('outcome_unknown');
  });

  it('has exactly the documented states', () => {
    expect(SubmissionState.options).toEqual([
      'intent_persisted',
      'sent',
      'accepted',
      'outcome_unknown',
      'completed',
      'interrupted',
      'failed',
      'canceled',
    ]);
  });
});

describe('effective profile', () => {
  it('maps an observed upstream thread and preserves route identity', () => {
    const thread = UpstreamThread.parse({
      schema_version: 2,
      id: THREAD,
      model: 'deepseek-flash',
      model_provider: 'deepseek',
      model_provider_id: 'deepseek',
      workspace: 'X:\\projects\\demo',
      mode: 'agent',
      permission_posture: 'full_access',
      allow_shell: true,
      trust_mode: true,
      auto_approve: true,
      archived: false,
    });
    const profile = toEffectiveProfile(thread, '2026-11-12T00:00:00Z');
    expect(profile.provider).toBe('deepseek');
    expect(profile.model).toBe('deepseek-flash');
    expect(profile.permissionPosture).toBe('full_access');
  });

  it('refuses a thread whose id is not a thread id', () => {
    expect(() =>
      toEffectiveProfile({
        schema_version: 2,
        id: 'prj_0123456789abcdef0123456789abcdef',
        model: 'deepseek-flash',
        model_provider: 'deepseek',
        workspace: 'X:\\projects\\demo',
        mode: 'agent',
        permission_posture: 'full_access',
        allow_shell: true,
        trust_mode: true,
        auto_approve: true,
      }),
    ).toThrow();
  });

  it('does not invent a permission posture it did not observe', () => {
    const profile = toEffectiveProfile({
      schema_version: 2,
      id: THREAD,
      model: 'deepseek-flash',
      model_provider: 'deepseek',
      workspace: 'X:\\projects\\demo',
      mode: 'agent',
      permission_posture: 'sudo_everything',
      allow_shell: false,
      trust_mode: false,
      auto_approve: false,
    });
    expect(profile.permissionPosture).toBe('unknown');
  });
});

describe('approval and error contracts', () => {
  it('reads an approval request in either wire spelling and requires an id', () => {
    expect(
      ApprovalRequiredPayload.safeParse({ approvalId: 'a1', toolName: 'bash', description: 'run a command' }).success,
    ).toBe(true);
    // The pinned runtime's own spelling is snake_case; a payload without a tool
    // name is still readable, because the id is what a reply is addressed to.
    expect(ApprovalRequiredPayload.safeParse({ approval_id: 'a2', tool_name: 'bash' }).success).toBe(true);
    expect(ApprovalRequiredPayload.safeParse({ approval_id: 'a3' }).success).toBe(true);

    const normalized = normalizeApprovalRequired({ approval_id: 'a2', tool_name: 'bash', intent_summary: 'x' });
    expect(normalized).toEqual({
      approvalId: 'a2',
      toolName: 'bash',
      description: 'The runtime is waiting for approval to continue.',
      intentSummary: 'x',
    });
    // An id-less payload is not answerable, so it is refused rather than invented.
    expect(normalizeApprovalRequired({ description: 'nothing to address' })).toBeNull();
    expect(ApprovalRequiredPayload.safeParse({ approval_id: 'a1', unknown_field: 1 }).success).toBe(true);
  });

  it('reads a clarification request from both payload placements', () => {
    const nested = normalizeUserInputRequired({
      request_id: 'r1',
      request: { questions: [{ id: 'q1', header: 'Pick', options: [{ label: 'a' }] }] },
    });
    expect(nested?.requestId).toBe('r1');
    expect(nested?.questions[0]?.id).toBe('q1');
    const flat = normalizeUserInputRequired({ input_id: 'r2', questions: [{ id: 'q1' }] });
    expect(flat?.requestId).toBe('r2');
    // No id or no questions means there is nothing to answer.
    expect(normalizeUserInputRequired({ request: { questions: [] }, request_id: 'r3' })).toBeNull();
    expect(normalizeUserInputRequired({ questions: [{ id: 'q1' }] })).toBeNull();
  });

  it('builds a typed error result without extra fields', () => {
    expect(errorResult('engine_unavailable', 'runtime not running', true).code).toBe('engine_unavailable');
    expect(ErrorResult.safeParse({ code: 'nope', message: 'x', retryable: false }).success).toBe(false);
  });

  it('labels fixtures as test-only', () => {
    expect(FIXTURES.every((fixture) => fixture.marker === 'mona.fixture.test-only')).toBe(true);
  });
});
