import { describe, expect, it } from 'vitest';
import { newOperationKey, newSubmissionId, type SubmissionRecord } from '@mona/contracts';
import { EngineAdapter, type AdapterStreamEvent } from './adapter.js';
import type { RuntimeTransport, TransportResponse } from './http.js';
import { MemorySubmissionJournal } from './journal.js';
import type { Result } from './errors.js';
import { SseDecoder } from './sse.js';

const THREAD = 'thr_0123456789abcdef0123456789abcdef';
const TURN = 'turn_0123456789abcdef0123456789abcdef';
const OTHER_THREAD = 'thr_ffffffffffffffffffffffffffffffff';

const workspace = 'C:\\work\\demo';

function runtimeInfo(overrides: Record<string, unknown> = {}) {
  const capabilities: Record<string, boolean> = {
    client_token_intents: true,
    account_session: true,
    account_model_owner: true,
    session_provider_keys: false,
    threads: true,
    thread_create_idempotency: true,
    thread_shell_consent: true,
    turns: true,
    turn_operation_idempotency: true,
    turn_operation_lookup: true,
    automation_mutation_preconditions: true,
    turn_image_inputs: true,
    turn_output_token_limit: true,
    profile_constitution: true,
    turn_steer: true,
    turn_interrupt: true,
    event_replay: true,
    external_tools: true,
    environments: false,
    worker_runtime: true,
    fleet_run_create: true,
    fleet_run_start: true,
    fleet_event_replay: true,
    fleet_event_stream: true,
    thread_goals: true,
    memory: true,
    mcp_server_management: true,
    skill_lifecycle: true,
    skill_detail: true,
    plugin_management: true,
    agent_mail: true,
    terminal_stream: false,
    terminal_input: false,
    terminal_resize: false,
    terminal_kill: false,
    event_stream_resume: true,
  };
  return {
    service: 'codewhale-runtime-api',
    runtime_api_version: '1.0',
    codewhale_version: '0.10.2',
    codewhale_commit: 'ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e',
    bind_host: '127.0.0.1',
    port: 7900,
    auth_required: true,
    capabilities: { ...capabilities, ...overrides },
  };
}

function thread(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    id: THREAD,
    model: 'deepseek-flash',
    model_provider: 'deepseek',
    model_provider_id: 'deepseek',
    workspace,
    mode: 'agent',
    permission_posture: 'full_access',
    allow_shell: true,
    trust_mode: true,
    auto_approve: true,
    archived: false,
    ...overrides,
  };
}

function turn(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    id: TURN,
    thread_id: THREAD,
    status: 'in_progress',
    ...overrides,
  };
}

class ScriptedTransport implements RuntimeTransport {
  readonly jsonCalls: Array<{ method: string; path: string; body: unknown }> = [];
  readonly streamCalls: Array<{ path: string }> = [];
  private readonly jsonQueue: Array<
    (call: { method: string; path: string; body: unknown }) => Result<TransportResponse>
  > = [];
  private readonly streamQueue: Array<Result<AsyncIterable<Uint8Array>>> = [];

  onJson(handler: (call: { method: string; path: string; body: unknown }) => Result<TransportResponse>): this {
    this.jsonQueue.push(handler);
    return this;
  }

  onStream(result: Result<AsyncIterable<Uint8Array>>): this {
    this.streamQueue.push(result);
    return this;
  }

  async json(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Result<TransportResponse>> {
    const call = { method, path, body };
    this.jsonCalls.push(call);
    const next = this.jsonQueue.shift();
    if (!next)
      return {
        ok: false,
        error: { code: 'internal', message: `no scripted response for ${method} ${path}`, retryable: false },
      };
    return next(call);
  }

  async stream(path: string): Promise<Result<AsyncIterable<Uint8Array>>> {
    this.streamCalls.push({ path });
    const next = this.streamQueue.shift();
    if (!next)
      return { ok: false, error: { code: 'internal', message: `no scripted stream for ${path}`, retryable: false } };
    return next;
  }
}

function jsonResponse(json: unknown, status = 200): Result<TransportResponse> {
  return { ok: true, value: { status, json, bytes: JSON.stringify(json).length } };
}

function failure(
  code: 'transport_failed' | 'authentication_failed' | 'not_found' | 'stream_closed',
  retryable = false,
): Result<never> {
  return { ok: false, error: { code, message: code, retryable } };
}

function makeAdapter(transport: RuntimeTransport, journal = new MemorySubmissionJournal(), maxEventBytes?: number) {
  return new EngineAdapter({
    transport,
    journal,
    context: { baseUrl: 'http://127.0.0.1:7900', pid: 1234, workspace, startedAt: '2026-11-12T00:00:00Z' },
    now: () => '2026-11-12T00:00:00Z',
    ...(maxEventBytes ? { maxEventBytes } : {}),
  });
}

function envelope(seq: number, event: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    seq,
    event,
    thread_id: THREAD,
    turn_id: TURN,
    item_id: null,
    timestamp: '2026-11-12T00:00:00Z',
    created_at: '2026-11-12T00:00:00Z',
    payload,
    ...overrides,
  };
}

function sse(frame: { event?: string; id?: string; data: unknown }): string {
  const lines = [];
  if (frame.id) lines.push(`id: ${frame.id}`);
  if (frame.event) lines.push(`event: ${frame.event}`);
  lines.push(`data: ${typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)}`);
  return `${lines.join('\n')}\n\n`;
}

async function collect(iterable: AsyncIterable<AdapterStreamEvent>, limit = 100): Promise<AdapterStreamEvent[]> {
  const out: AdapterStreamEvent[] = [];
  for await (const item of iterable) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

describe('discovery and compatibility', () => {
  it('qualifies the pinned runtime and maps capabilities', async () => {
    const transport = new ScriptedTransport().onJson(() => jsonResponse(runtimeInfo()));
    const adapter = makeAdapter(transport);
    const result = await adapter.discover();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.report.status).toBe('qualified');
      expect(result.value.capabilities.turnOperationIdempotency).toBe(true);
      expect(result.value.capabilities.terminalStream).toBe(false);
      expect(result.value.identity.commit).toMatch(/^ff466b2ed0bf/);
    }
  });

  it('marks a different patch version as compatible but unqualified', async () => {
    const transport = new ScriptedTransport().onJson(() =>
      jsonResponse({ ...runtimeInfo(), codewhale_version: '0.10.3' }),
    );
    const result = await makeAdapter(transport).discover();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.report.status).toBe('compatible_unqualified');
      expect(result.value.report.reasons.join(' ')).toContain('version drift');
    }
  });

  it('refuses an unsupported engine version', async () => {
    const transport = new ScriptedTransport().onJson(() =>
      jsonResponse({ ...runtimeInfo(), codewhale_version: '0.11.0' }),
    );
    const result = await makeAdapter(transport).discover();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.report.status).toBe('unsupported');
  });

  it('reports schema drift instead of guessing', async () => {
    const transport = new ScriptedTransport().onJson(() => jsonResponse({ service: 'something-else' }));
    const result = await makeAdapter(transport).discover();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('schema_drift');
  });
});

describe('threads and profiles', () => {
  it('creates a thread and maps effective Full Access settings', async () => {
    const transport = new ScriptedTransport()
      .onJson(() => jsonResponse(runtimeInfo()))
      .onJson(() => jsonResponse(thread(), 201));
    const adapter = makeAdapter(transport);
    const result = await adapter.createOrOpenThread({ allowShell: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.profile.permissionPosture).toBe('full_access');
      expect(result.value.profile.provider).toBe('deepseek');
      expect(result.value.profile.model).toBe('deepseek-flash');
    }
    const post = transport.jsonCalls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({ mode: 'agent', allow_shell: true, trust_mode: true, auto_approve: true });
  });

  it('rejects a thread bound to a different workspace', async () => {
    const transport = new ScriptedTransport()
      .onJson(() => jsonResponse(runtimeInfo()))
      .onJson(() => jsonResponse(thread({ workspace: 'C:\\other' }), 201));
    const result = await makeAdapter(transport).createOrOpenThread({ expectedWorkspace: workspace });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_request');
  });

  it('rejects a profile answer for another thread', async () => {
    const transport = new ScriptedTransport().onJson(() =>
      jsonResponse({ thread: thread({ id: OTHER_THREAD }), latest_seq: 1 }),
    );
    const result = await makeAdapter(transport).getEffectiveProfile(THREAD as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('thread_mismatch');
  });
});

describe('submission safety', () => {
  it('persists intent before sending and records acceptance', async () => {
    let putCompleted = false;
    class ObservingJournal extends MemorySubmissionJournal {
      override async put(record: SubmissionRecord): Promise<void> {
        await super.put(record);
        putCompleted = true;
      }
    }
    const journal = new ObservingJournal();
    const submissionId = newSubmissionId();
    let intentVisibleAtSend = false;
    const transport = new ScriptedTransport()
      .onJson(() => jsonResponse(runtimeInfo()))
      .onJson(() => {
        intentVisibleAtSend = putCompleted;
        return jsonResponse({ thread: thread(), turn: turn() }, 201);
      });
    const adapter = makeAdapter(transport, journal);
    const result = await adapter.submitTurn({
      threadId: THREAD as never,
      prompt: 'do the task',
      operationKey: newOperationKey('turn'),
      submissionId,
    });
    expect(result.ok).toBe(true);
    expect(intentVisibleAtSend).toBe(true);
    if (result.ok) {
      expect(result.value.state).toBe('accepted');
      expect(result.value.turnId).toBe(TURN);
      expect(result.value.replayed).toBe(false);
    }
    const record = (await journal.get(submissionId)) as SubmissionRecord;
    expect(record.state).toBe('accepted');
    expect(record.operationKey).toBeTruthy();
    const post = transport.jsonCalls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({ prompt: 'do the task', operation_key: record.operationKey });
  });

  it('recognises an idempotent replay instead of creating a second turn', async () => {
    const transport = new ScriptedTransport()
      .onJson(() => jsonResponse(runtimeInfo()))
      .onJson(() => jsonResponse({ thread: thread(), turn: turn(), idempotent_replay: true }, 200));
    const result = await makeAdapter(transport).submitTurn({
      threadId: THREAD as never,
      prompt: 'same task',
      operationKey: newOperationKey('turn'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.replayed).toBe(true);
  });

  it('reconciles a lost response without a second POST', async () => {
    const journal = new MemorySubmissionJournal();
    const submissionId = newSubmissionId();
    const transport = new ScriptedTransport()
      .onJson(() => jsonResponse(runtimeInfo()))
      .onJson(() => failure('transport_failed', true))
      .onJson(() => jsonResponse(turn({ status: 'completed' })));
    const result = await makeAdapter(transport, journal).submitTurn({
      threadId: THREAD as never,
      prompt: 'lost response',
      operationKey: newOperationKey('turn'),
      submissionId,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state).toBe('completed');
      expect(result.value.turnId).toBe(TURN);
      expect(result.value.replayed).toBe(true);
    }
    expect(transport.jsonCalls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(transport.jsonCalls.some((call) => call.path.includes('/turn-operations/'))).toBe(true);
  });

  it('returns outcome-unknown when lookup has no record and never retries', async () => {
    const journal = new MemorySubmissionJournal();
    const submissionId = newSubmissionId();
    const transport = new ScriptedTransport()
      .onJson(() => jsonResponse(runtimeInfo()))
      .onJson(() => failure('transport_failed', true))
      .onJson(() => failure('not_found'));
    const result = await makeAdapter(transport, journal).submitTurn({
      threadId: THREAD as never,
      prompt: 'lost and unknown',
      operationKey: newOperationKey('turn'),
      submissionId,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state).toBe('outcome_unknown');
      expect(result.value.reconciliation.required).toBe(true);
    }
    expect(transport.jsonCalls.filter((call) => call.method === 'POST')).toHaveLength(1);
    const record = await journal.get(submissionId);
    expect(record?.state).toBe('outcome_unknown');
  });

  it('does not lookup or retry when the runtime lacks operation lookup', async () => {
    const transport = new ScriptedTransport()
      .onJson(() => jsonResponse(runtimeInfo({ turn_operation_lookup: false })))
      .onJson(() => failure('transport_failed', true));
    const result = await makeAdapter(transport).submitTurn({
      threadId: THREAD as never,
      prompt: 'old runtime',
      operationKey: newOperationKey('turn'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state).toBe('outcome_unknown');
      expect(result.value.reconciliation.guidance).toContain('inspect history');
    }
    expect(transport.jsonCalls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(transport.jsonCalls.some((call) => call.path.includes('/turn-operations/'))).toBe(false);
  });

  it('refuses to mutate when the runtime answers for another thread', async () => {
    const journal = new MemorySubmissionJournal();
    const submissionId = newSubmissionId();
    const transport = new ScriptedTransport()
      .onJson(() => jsonResponse(runtimeInfo()))
      .onJson(() =>
        jsonResponse({ thread: thread({ id: OTHER_THREAD }), turn: turn({ thread_id: OTHER_THREAD }) }, 201),
      );
    const result = await makeAdapter(transport, journal).submitTurn({
      threadId: THREAD as never,
      prompt: 'wrong thread',
      operationKey: newOperationKey('turn'),
      submissionId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('thread_mismatch');
    const record = await journal.get(submissionId);
    expect(record?.state).toBe('outcome_unknown');
    expect(record?.turnId).toBeNull();
  });

  it('surfaces a capability failure when turns are not advertised', async () => {
    const transport = new ScriptedTransport().onJson(() => jsonResponse(runtimeInfo({ turns: false })));
    const result = await makeAdapter(transport).submitTurn({
      threadId: THREAD as never,
      prompt: 'nope',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('capability_unsupported');
  });
});

describe('event streaming', () => {
  it('deduplicates replay across a reconnect and converges on the same state', async () => {
    const first = (async function* () {
      yield new TextEncoder().encode(
        sse({ event: 'item.delta', data: envelope(1, 'item.delta', { delta: 'a' }) }) +
          sse({ event: 'item.delta', data: envelope(2, 'item.delta', { delta: 'b' }) }) +
          sse({ event: 'item.delta', data: envelope(3, 'item.delta', { delta: 'c' }) }),
      );
      throw new Error('connection dropped');
    })();
    const second = (async function* () {
      yield new TextEncoder().encode(
        sse({ event: 'item.delta', data: envelope(3, 'item.delta', { delta: 'c' }) }) +
          sse({ event: 'item.delta', data: envelope(4, 'item.delta', { delta: 'd' }) }) +
          sse({ event: 'item.delta', data: envelope(5, 'item.delta', { delta: 'e' }) }) +
          sse({ event: 'stream.end', data: { last_seq: 5, retryable: false, reason: 'runtime_shutdown' } }),
      );
    })();
    const transport = new ScriptedTransport()
      .onStream({ ok: true, value: first })
      .onStream({ ok: true, value: second });
    const events = await collect(
      makeAdapter(transport).subscribe({
        threadId: THREAD as never,
        baseDelayMs: 1,
        maxDelayMs: 1,
        maxAttempts: 3,
      }),
    );
    const seqs = events.filter((event) => event.kind === 'event').map((event) => event.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(events.filter((event) => event.kind === 'reconnected')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'stream_end')).toHaveLength(1);
    expect(transport.streamCalls[1]?.path).toContain('since_seq=3');
  });

  it('keeps unknown events and reports malformed known payloads without dying', async () => {
    const stream = (async function* () {
      yield new TextEncoder().encode(
        sse({ event: 'model.tools.snapshot', data: envelope(1, 'model.tools.snapshot', { tool_count: 15 }) }) +
          sse({ event: 'turn.completed', data: envelope(2, 'turn.completed', { status: 'done' }) }) +
          sse({
            event: 'stream.end',
            data: { last_seq: 2, retryable: false, reason: 'runtime_shutdown' },
          }),
      );
    })();
    const transport = new ScriptedTransport().onStream({ ok: true, value: stream });
    const events = await collect(makeAdapter(transport).subscribe({ threadId: THREAD as never }));
    expect(events.some((event) => event.kind === 'event' && event.event.kind === 'unknown')).toBe(true);
    expect(events.some((event) => event.kind === 'diagnostic' && event.failure.code === 'schema_drift')).toBe(true);
    expect(events.some((event) => event.kind === 'stream_end')).toBe(true);
  });

  it('stops reconnecting on an authentication failure', async () => {
    const transport = new ScriptedTransport().onStream(failure('authentication_failed'));
    const events = await collect(makeAdapter(transport).subscribe({ threadId: THREAD as never, baseDelayMs: 1 }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'diagnostic', failure: { code: 'authentication_failed' } });
    expect(transport.streamCalls).toHaveLength(1);
  });

  it('drops an oversized frame and continues with the next one', async () => {
    const huge = 'x'.repeat(4000);
    const stream = (async function* () {
      yield new TextEncoder().encode(
        `event: item.delta\ndata: {"seq":1,"pad":"${huge}"}\n\n` +
          sse({ event: 'item.delta', data: envelope(2, 'item.delta', { delta: 'ok' }) }) +
          sse({ event: 'stream.end', data: { last_seq: 2, retryable: false, reason: 'runtime_shutdown' } }),
      );
    })();
    const transport = new ScriptedTransport().onStream({ ok: true, value: stream });
    const events = await collect(
      makeAdapter(transport, new MemorySubmissionJournal(), 1024).subscribe({ threadId: THREAD as never }),
    );
    expect(events.some((event) => event.kind === 'diagnostic' && event.failure.code === 'oversize_event')).toBe(true);
    expect(events.some((event) => event.kind === 'event' && event.seq === 2)).toBe(true);
  });
});

describe('history, usage, interrupt, capabilities', () => {
  it('rejects history for another thread', async () => {
    const transport = new ScriptedTransport().onJson(() =>
      jsonResponse({ runtime_thread_id: OTHER_THREAD, session: { messages: [] } }),
    );
    const result = await makeAdapter(transport).readHistory({ threadId: THREAD as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('thread_mismatch');
  });

  it('maps known cost and preserves unknown cost', async () => {
    const known = new ScriptedTransport().onJson(() =>
      jsonResponse({
        thread_id: THREAD,
        totals: {
          input_tokens: 100,
          output_tokens: 10,
          cached_tokens: 50,
          reasoning_tokens: 0,
          cost_usd: 0.001,
          cost_complete: true,
          unpriced_turns: 0,
          pricing_provenances: ['provider_docs'],
          turns: 1,
        },
      }),
    );
    const knownResult = await makeAdapter(known).readUsage({ threadId: THREAD as never });
    expect(knownResult.ok).toBe(true);
    if (knownResult.ok) {
      expect(knownResult.value.cost).toMatchObject({ status: 'known', usd: 0.001, source: 'engine_priced' });
      expect(knownResult.value.buckets.inputMissTokens).toBe(100);
      expect(knownResult.value.buckets.cacheHitTokens).toBe(50);
    }

    const unknown = new ScriptedTransport().onJson(() =>
      jsonResponse({
        thread_id: THREAD,
        totals: {
          input_tokens: 100,
          output_tokens: 10,
          cached_tokens: 0,
          reasoning_tokens: 0,
          cost_usd: null,
          cost_complete: false,
          unpriced_turns: 1,
          unpriced_reasons: ['model not priced'],
          turns: 1,
        },
      }),
    );
    const unknownResult = await makeAdapter(unknown).readUsage({ threadId: THREAD as never });
    expect(unknownResult.ok).toBe(true);
    if (unknownResult.ok) {
      expect(unknownResult.value.cost.status).toBe('unknown');
      if (unknownResult.value.cost.status === 'unknown')
        expect(unknownResult.value.cost.reason).toContain('not priced');
    }
  });

  it('interrupts only the requested turn on the requested thread', async () => {
    const okTransport = new ScriptedTransport().onJson(() => jsonResponse(turn({ status: 'in_progress' })));
    const okResult = await makeAdapter(okTransport).interrupt({ threadId: THREAD as never, turnId: TURN as never });
    expect(okResult.ok).toBe(true);
    if (okResult.ok) expect(okResult.value.acknowledgedStatus).toBe('in_progress');

    const wrong = new ScriptedTransport().onJson(() => jsonResponse(turn({ thread_id: OTHER_THREAD })));
    const wrongResult = await makeAdapter(wrong).interrupt({ threadId: THREAD as never, turnId: TURN as never });
    expect(wrongResult.ok).toBe(false);
    if (!wrongResult.ok) expect(wrongResult.error.code).toBe('thread_mismatch');
  });

  it('posts an approval decision to the runtime route and refuses a mismatched echo', async () => {
    const transport = new ScriptedTransport().onJson((call) => {
      expect(call.method).toBe('POST');
      expect(call.path).toBe('/v1/approvals/appr%2F1');
      expect(call.body).toEqual({ decision: 'allow', remember: true });
      return jsonResponse({ approval_id: 'appr/1', decision: 'allow' });
    });
    const result = await makeAdapter(transport).respondToApproval({
      threadId: THREAD as never,
      approvalId: 'appr/1',
      decision: 'allow',
      remember: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.decision).toBe('allow');
      expect(result.value.echoed).toBe(true);
    }

    // A runtime that names a different approval is not evidence this one was decided.
    const other = new ScriptedTransport().onJson(() => jsonResponse({ approval_id: 'appr_other', decision: 'allow' }));
    const mismatch = await makeAdapter(other).respondToApproval({
      threadId: THREAD as never,
      approvalId: 'appr_1',
      decision: 'allow',
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe('thread_mismatch');

    // A different recorded decision is a drift, not a success.
    const drifted = new ScriptedTransport().onJson(() => jsonResponse({ approval_id: 'appr_1', decision: 'deny' }));
    const drift = await makeAdapter(drifted).respondToApproval({
      threadId: THREAD as never,
      approvalId: 'appr_1',
      decision: 'allow',
    });
    expect(drift.ok).toBe(false);
    if (!drift.ok) expect(drift.error.code).toBe('schema_drift');
  });

  it('posts a clarification answer to the thread and request it belongs to', async () => {
    const transport = new ScriptedTransport().onJson((call) => {
      expect(call.method).toBe('POST');
      expect(call.path).toBe(`/v1/user-input/${THREAD}/req%201`);
      expect(call.body).toEqual({ answers: [{ id: 'q1', label: 'dist', value: 'dist' }] });
      return jsonResponse({ thread_id: THREAD, request_id: 'req 1', accepted: true });
    });
    const result = await makeAdapter(transport).respondToUserInput({
      threadId: THREAD as never,
      requestId: 'req 1',
      answers: [{ id: 'q1', label: 'dist', value: 'dist' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.answers).toBe(1);

    const rejected = new ScriptedTransport().onJson(() => jsonResponse({ thread_id: THREAD, accepted: false }));
    const refused = await makeAdapter(rejected).respondToUserInput({
      threadId: THREAD as never,
      requestId: 'req 2',
      answers: [{ id: 'q1', label: 'dist', value: 'dist' }],
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('invalid_request');

    // An expired request is the runtime's 404; it is surfaced, never retried.
    const gone = new ScriptedTransport().onJson(() => failure('not_found'));
    const expired = await makeAdapter(gone).respondToUserInput({
      threadId: THREAD as never,
      requestId: 'req 3',
      answers: [{ id: 'q1', label: 'dist', value: 'dist' }],
    });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe('not_found');
  });

  it('uses the current provider for models.list instead of hard-coding one', async () => {
    const transport = new ScriptedTransport()
      .onJson(() => jsonResponse(runtimeInfo()))
      .onJson(() => jsonResponse({ current: 'deepseek', providers: [] }))
      .onJson(() => jsonResponse({ provider: 'deepseek', models: [] }));
    const result = await makeAdapter(transport).invokeCapability({ name: 'models.list' });
    expect(result.ok).toBe(true);
    expect(transport.jsonCalls.at(-1)?.path).toBe('/v1/providers/deepseek/models');
  });
});

describe('SSE decoder', () => {
  it('handles UTF-8 split across chunks and CRLF frames', () => {
    const decoder = new SseDecoder(4096);
    const bytes = new TextEncoder().encode('event: item.delta\r\ndata: {"delta":"héllo"}\r\n\r\n');
    const first = decoder.push(bytes.slice(0, 32)).frames;
    const second = decoder.push(bytes.slice(32)).frames;
    const frames = [...first, ...second];
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!.data)).toEqual({ delta: 'héllo' });
  });

  it('ignores comments and joins multi-line data', () => {
    const decoder = new SseDecoder(4096);
    const { frames } = decoder.push(new TextEncoder().encode(': keepalive\nevent: x\ndata: {"a":1,\ndata: "b":2}\n\n'));
    expect(frames[0]?.event).toBe('x');
    expect(JSON.parse(frames[0]!.data)).toEqual({ a: 1, b: 2 });
  });
});
