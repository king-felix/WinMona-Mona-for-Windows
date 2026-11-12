import { z } from 'zod';
import {
  OperationKey,
  StreamEndPayload,
  SubmissionId,
  ProjectId,
  ThreadId,
  TurnId,
  newOperationKey,
  newSubmissionId,
  parseEngineEvent,
  toEventEnvelope,
  type EffectiveProfile,
  type EngineEventEnvelope,
  type ParsedEngineEvent,
  type SubmissionRecord,
  type SubmissionState,
  type UsageEvidence,
} from '@mona/contracts';
import { assessCompatibility, type DiscoveryContext, type EngineDiscovery } from './compatibility.js';
import { EngineConfiguration } from './configuration.js';
import { fail, isAbortError, ok, type AdapterFailure, type Result } from './errors.js';
import type { RuntimeTransport } from './http.js';
import { NativeOrchestration } from './native.js';
import type { SubmissionJournal } from './journal.js';
import {
  HistoryWire,
  ThreadEnvelope,
  TurnSubmitWire,
  mapEffectiveProfile,
  mapUsage,
  verifyThreadId,
} from './mapping.js';
import { SseDecoder, parseSseJson } from './sse.js';

export const ThreadOpenInput = z
  .object({
    operationKey: OperationKey.optional(),
    mode: z.enum(['agent', 'plan']).default('agent'),
    allowShell: z.boolean().default(true),
    trustMode: z.boolean().default(true),
    autoApprove: z.boolean().default(true),
    expectedWorkspace: z.string().min(1).optional(),
  })
  .strict();
export type ThreadOpenInput = z.input<typeof ThreadOpenInput>;

export const TurnRequest = z
  .object({
    threadId: ThreadId,
    prompt: z.string().min(1).max(100_000),
    operationKey: OperationKey.optional(),
    submissionId: SubmissionId.optional(),
    allowShell: z.boolean().default(true),
    trustMode: z.boolean().default(true),
    autoApprove: z.boolean().default(true),
  })
  .strict();
export type TurnRequest = z.input<typeof TurnRequest>;

export const SubscriptionRequest = z
  .object({
    threadId: ThreadId,
    sinceSeq: z.number().int().nonnegative().default(0),
    replayLimit: z.number().int().nonnegative().max(1000).default(0),
    reconnect: z.boolean().default(true),
    maxAttempts: z.number().int().min(0).max(20).default(4),
    baseDelayMs: z.number().int().min(1).max(60_000).default(300),
    maxDelayMs: z.number().int().min(1).max(120_000).default(5_000),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();
export type SubscriptionRequest = z.input<typeof SubscriptionRequest>;

export const HistoryQuery = z
  .object({
    threadId: ThreadId,
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();
export type HistoryQuery = z.input<typeof HistoryQuery>;

export const UsageQuery = z.object({ threadId: ThreadId }).strict();
export type UsageQuery = z.input<typeof UsageQuery>;

export const InterruptRequest = z.object({ threadId: ThreadId, turnId: TurnId }).strict();
export type InterruptRequest = z.input<typeof InterruptRequest>;

export const CapabilityInvocation = z
  .object({
    name: z.enum(['runtime.info', 'providers.list', 'models.list', 'skills.list', 'goals.list', 'tasks.list']),
    provider: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,40}$/)
      .optional(),
  })
  .strict();
export type CapabilityInvocation = z.input<typeof CapabilityInvocation>;

export type ThreadRef = {
  threadId: ThreadId;
  profile: EffectiveProfile;
  latestSeq: number;
};

export type SubmissionReceipt = {
  submissionId: SubmissionId;
  operationKey: string;
  threadId: ThreadId;
  turnId: TurnId | null;
  state: SubmissionState;
  replayed: boolean;
  reconciliation: { required: boolean; guidance?: string };
};

export type SubmissionStatus = SubmissionReceipt;

export type InterruptReceipt = {
  threadId: ThreadId;
  turnId: TurnId;
  acknowledgedStatus: string;
};

export type HistoryPage = {
  threadId: ThreadId;
  messageCount: number;
  messages: unknown[];
  documentDigest: string | null;
};

export type CapabilityResult = {
  name: string;
  data: unknown;
};

export type AdapterStreamEvent =
  | { kind: 'event'; seq: number; event: ParsedEngineEvent }
  | { kind: 'stream_end'; lastSeq: number; retryable: boolean; reason: string }
  | { kind: 'reconnected'; sinceSeq: number; attempt: number }
  | { kind: 'diagnostic'; failure: AdapterFailure };

export type EngineAdapterOptions = {
  transport: RuntimeTransport;
  journal: SubmissionJournal;
  context: DiscoveryContext;
  now?: () => string;
  maxEventBytes?: number;
};

const TERMINAL: ReadonlySet<SubmissionState> = new Set(['completed', 'interrupted', 'failed', 'canceled']);

/**
 * Versioned Codewhale runtime adapter. Every operation validates inputs and
 * results, returns typed failures, and never retries a possibly accepted write.
 */
export class EngineAdapter {
  private readonly transport: RuntimeTransport;
  private readonly journal: SubmissionJournal;
  private readonly context: DiscoveryContext;
  private readonly now: () => string;
  private readonly maxEventBytes: number;
  private discovery: EngineDiscovery | null = null;

  constructor(options: EngineAdapterOptions) {
    this.transport = options.transport;
    this.journal = options.journal;
    this.context = options.context;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxEventBytes = options.maxEventBytes ?? 1024 * 1024;
  }

  /** Native goals, fleets, runs and agent records over the same transport. */
  orchestration(): NativeOrchestration {
    return new NativeOrchestration(this.transport);
  }

  /** Read-only provider/model/settings projections over the same transport. */
  configuration(): EngineConfiguration {
    return new EngineConfiguration(this.transport, () => new Date(this.now()));
  }

  async discover(): Promise<Result<EngineDiscovery>> {
    const response = await this.transport.json('GET', '/v1/runtime/info');
    if (!response.ok) return response;
    const assessed = assessCompatibility(response.value.json, this.context);
    if (!assessed.ok) return assessed;
    this.discovery = assessed.value;
    return assessed;
  }

  async createOrOpenThread(input: ThreadOpenInput): Promise<Result<ThreadRef>> {
    const parsed = ThreadOpenInput.safeParse(input);
    if (!parsed.success) {
      return fail('invalid_request', 'thread request failed validation', {
        detail: parsed.error.issues
          .map((issue) => issue.message)
          .join('; ')
          .slice(0, 500),
      });
    }
    await this.ensureDiscovery();
    const body: Record<string, unknown> = {
      mode: parsed.data.mode,
      allow_shell: parsed.data.allowShell,
      trust_mode: parsed.data.trustMode,
      auto_approve: parsed.data.autoApprove,
    };
    if (parsed.data.operationKey) body.operation_key = parsed.data.operationKey;
    const response = await this.transport.json('POST', '/v1/threads', body);
    if (!response.ok) return response;
    const profileResult = this.profileFromThread(response.value.json, parsed.data.expectedWorkspace);
    if (!profileResult.ok) return profileResult;
    return ok({ threadId: profileResult.value.threadId, profile: profileResult.value, latestSeq: 0 });
  }

  async getEffectiveProfile(threadId: ThreadId): Promise<Result<EffectiveProfile>> {
    const thread = await this.readThread(threadId);
    return thread.ok ? ok(thread.value.profile) : thread;
  }

  async submitTurn(input: TurnRequest): Promise<Result<SubmissionReceipt>> {
    const parsed = TurnRequest.safeParse(input);
    if (!parsed.success) {
      return fail('invalid_request', 'turn request failed validation', {
        detail: parsed.error.issues
          .map((issue) => issue.message)
          .join('; ')
          .slice(0, 500),
      });
    }
    const request = parsed.data;
    const discovery = await this.ensureDiscovery();
    if (!discovery.ok) return discovery;
    if (!discovery.value.capabilities.turns) {
      return fail('capability_unsupported', 'this runtime does not advertise turn submission');
    }

    const operationKey = request.operationKey ?? newOperationKey('turn');
    const existing = await this.journal.findByOperationKey(request.threadId, operationKey);
    if (existing) {
      if (TERMINAL.has(existing.state)) return ok(receiptFrom(existing, true));
      const reconciled = await this.reconcileSubmission({ submissionId: existing.id });
      if (!reconciled.ok) return reconciled;
      return ok({ ...reconciled.value, replayed: true });
    }

    const submissionId = request.submissionId ?? newSubmissionId();
    const intent: SubmissionRecord = {
      id: submissionId,
      projectId: PLACEHOLDER_PROJECT_ID,
      taskId: null,
      threadId: request.threadId,
      turnId: null,
      operationKey,
      state: 'intent_persisted',
      intentPersistedAt: this.now(),
      dispatchedAt: null,
      lastObservedAt: this.now(),
      reconciliation: { required: false },
    };
    try {
      await this.journal.put(intent);
    } catch (error) {
      return fail('internal', 'could not persist submission intent; nothing was sent', {
        detail: error instanceof Error ? error.message.slice(0, 500) : undefined,
      });
    }

    const response = await this.transport.json('POST', `/v1/threads/${request.threadId}/turns`, {
      prompt: request.prompt,
      allow_shell: request.allowShell,
      trust_mode: request.trustMode,
      auto_approve: request.autoApprove,
      operation_key: operationKey,
    });
    if (!response.ok) {
      if (response.error.code === 'transport_failed' || response.error.code === 'stream_closed') {
        return this.markOutcomeUnknown(intent, response.error.detail ?? response.error.message);
      }
      await this.safeUpdate({ ...intent, state: 'failed', dispatchedAt: this.now(), lastObservedAt: this.now() });
      return response;
    }

    const wire = TurnSubmitWire.safeParse(response.value.json);
    if (!wire.success) {
      return this.markOutcomeUnknown(intent, 'runtime response did not match the turn contract');
    }
    const threadCheck = verifyThreadId(wire.data.thread.id, request.threadId);
    if (!threadCheck.ok) {
      await this.safeUpdate({
        ...intent,
        state: 'outcome_unknown',
        dispatchedAt: this.now(),
        lastObservedAt: this.now(),
        reconciliation: {
          required: true,
          guidance: 'Runtime answered for another thread; inspect both threads before retrying.',
        },
      });
      return threadCheck;
    }
    const turnCheck = verifyThreadId(wire.data.turn.thread_id, request.threadId);
    if (!turnCheck.ok) {
      await this.safeUpdate({
        ...intent,
        state: 'outcome_unknown',
        dispatchedAt: this.now(),
        lastObservedAt: this.now(),
        reconciliation: {
          required: true,
          guidance: 'Runtime returned a turn from another thread; inspect both threads before retrying.',
        },
      });
      return turnCheck;
    }
    const turnId = TurnId.safeParse(wire.data.turn.id);
    if (!turnId.success) {
      return this.markOutcomeUnknown(intent, 'runtime returned a turn id in an unknown shape');
    }
    const accepted = {
      ...intent,
      state: 'accepted' as const,
      turnId: turnId.data,
      dispatchedAt: intent.dispatchedAt ?? this.now(),
      lastObservedAt: this.now(),
      reconciliation: { required: false },
    };
    await this.safeUpdate(accepted);
    return ok(receiptFrom(accepted, wire.data.idempotent_replay === true || response.value.status === 200));
  }

  async reconcileSubmission(ref: { submissionId: SubmissionId }): Promise<Result<SubmissionStatus>> {
    const record = await this.journal.get(ref.submissionId);
    if (!record) return fail('not_found', 'submission record was not found');
    if (TERMINAL.has(record.state)) return ok(receiptFrom(record, false));
    const discovery = await this.ensureDiscovery();
    if (!discovery.ok) return discovery;
    if (!discovery.value.capabilities.turnOperationLookup) {
      return ok(
        receiptFrom(
          {
            ...record,
            state: record.state === 'intent_persisted' ? 'intent_persisted' : 'outcome_unknown',
            lastObservedAt: this.now(),
            reconciliation: {
              required: true,
              guidance:
                'This runtime has no turn operation lookup. Open the thread and inspect history before resubmitting; Mona will not retry automatically.',
            },
          },
          false,
        ),
      );
    }
    const lookup = await this.transport.json(
      'GET',
      `/v1/threads/${record.threadId}/turn-operations/${encodeURIComponent(record.operationKey)}`,
    );
    if (!lookup.ok) {
      if (lookup.error.code === 'not_found') {
        return ok(
          receiptFrom(
            {
              ...record,
              state: record.state === 'intent_persisted' ? 'sent' : 'outcome_unknown',
              lastObservedAt: this.now(),
              reconciliation: {
                required: true,
                guidance:
                  'The runtime has no record of this operation. It may not have been accepted; inspect the thread before sending it again.',
              },
            },
            false,
          ),
        );
      }
      return lookup;
    }
    const turn = z
      .object({ id: z.string().min(1), thread_id: z.string().min(1), status: z.string().min(1) })
      .passthrough()
      .safeParse(lookup.value.json);
    if (!turn.success) return fail('schema_drift', 'turn operation lookup returned an unexpected shape');
    const threadCheck = verifyThreadId(turn.data.thread_id, record.threadId);
    if (!threadCheck.ok) return threadCheck;
    const state = stateFromTurnStatus(turn.data.status);
    if (!state) {
      return fail('schema_drift', `runtime reported an unknown turn status ${turn.data.status}`);
    }
    const updated = {
      ...record,
      state,
      turnId: TurnId.safeParse(turn.data.id).success ? TurnId.parse(turn.data.id) : record.turnId,
      lastObservedAt: this.now(),
      reconciliation:
        state === 'outcome_unknown'
          ? { required: true, guidance: 'Runtime status is not terminal; keep observing before resubmitting.' }
          : { required: false },
    };
    await this.safeUpdate(updated);
    return ok(receiptFrom(updated, true));
  }

  async *subscribe(input: SubscriptionRequest): AsyncIterable<AdapterStreamEvent> {
    const parsed = SubscriptionRequest.safeParse(input);
    if (!parsed.success) {
      yield {
        kind: 'diagnostic',
        failure: {
          code: 'invalid_request',
          message: 'subscription request failed validation',
          retryable: false,
        },
      };
      return;
    }
    const request = parsed.data;
    let lastSeq = request.sinceSeq;
    let attempt = 0;
    let opened = false;
    while (!request.signal?.aborted) {
      if (opened) attempt += 1;
      if (attempt > request.maxAttempts) {
        yield {
          kind: 'diagnostic',
          failure: {
            code: 'stream_closed',
            message: 'event stream reconnect budget exhausted',
            retryable: true,
          },
        };
        return;
      }
      if (opened) yield { kind: 'reconnected', sinceSeq: lastSeq, attempt };
      opened = true;

      const query = new URLSearchParams({ since_seq: String(lastSeq) });
      if (request.replayLimit) query.set('replay_limit', String(request.replayLimit));
      const stream = await this.transport.stream(
        `/v1/threads/${request.threadId}/events?${query.toString()}`,
        request.signal ? { signal: request.signal } : {},
      );
      if (!stream.ok) {
        yield { kind: 'diagnostic', failure: stream.error };
        if (!request.reconnect || !stream.error.retryable || !(await this.backoff(attempt, request))) return;
        continue;
      }

      let endedByRuntime = false;
      let retryable = true;
      const decoder = new SseDecoder(this.maxEventBytes);
      try {
        for await (const chunk of stream.value) {
          const pushed = decoder.push(chunk);
          if (pushed.oversize) {
            yield {
              kind: 'diagnostic',
              failure: {
                code: 'oversize_event',
                message: `event frame exceeded ${this.maxEventBytes} bytes and was dropped`,
                retryable: true,
              },
            };
          }
          for (const frame of pushed.frames) {
            const json = parseSseJson(frame);
            if (!json.ok) {
              yield {
                kind: 'diagnostic',
                failure: { code: 'schema_drift', message: json.message, retryable: false },
              };
              continue;
            }
            if (frame.event === 'stream.end') {
              const rawEnd = z
                .object({
                  last_seq: z.number().int().nonnegative().optional(),
                  lastSeq: z.number().int().nonnegative().optional(),
                  retryable: z.boolean().optional(),
                  reason: z.string().optional(),
                  payload: z.record(z.string(), z.unknown()).optional(),
                })
                .passthrough()
                .safeParse(json.value);
              const source = rawEnd.success ? (rawEnd.data.payload ?? rawEnd.data) : null;
              const end = StreamEndPayload.safeParse(
                source
                  ? {
                      lastSeq: source.last_seq ?? source.lastSeq ?? lastSeq,
                      retryable: source.retryable ?? false,
                      reason: source.reason ?? 'stream ended',
                    }
                  : null,
              );
              if (end.success) {
                lastSeq = Math.max(lastSeq, end.data.lastSeq);
                retryable = end.data.retryable;
                yield { kind: 'stream_end', lastSeq, retryable, reason: end.data.reason };
              } else {
                yield {
                  kind: 'diagnostic',
                  failure: { code: 'schema_drift', message: 'stream.end payload was malformed', retryable: false },
                };
                retryable = false;
              }
              endedByRuntime = true;
              break;
            }
            let envelope: EngineEventEnvelope;
            try {
              envelope = toEventEnvelope(json.value);
            } catch (error) {
              yield {
                kind: 'diagnostic',
                failure: {
                  code: 'schema_drift',
                  message: 'event envelope did not match the runtime contract',
                  retryable: false,
                  detail: error instanceof Error ? error.message.slice(0, 300) : undefined,
                },
              };
              continue;
            }
            if (envelope.threadId !== request.threadId) {
              yield {
                kind: 'diagnostic',
                failure: {
                  code: 'thread_mismatch',
                  message: 'event stream delivered a different thread',
                  retryable: false,
                },
              };
              continue;
            }
            if (envelope.seq <= lastSeq) continue;
            lastSeq = envelope.seq;
            attempt = 0;
            const event = parseEngineEvent(envelope);
            if (!event.ok) {
              yield {
                kind: 'diagnostic',
                failure: { code: 'schema_drift', message: event.error, retryable: false },
              };
              continue;
            }
            yield { kind: 'event', seq: envelope.seq, event: event.event };
          }
          if (endedByRuntime) break;
        }
      } catch (error) {
        if (request.signal?.aborted || isAbortError(error)) return;
        yield {
          kind: 'diagnostic',
          failure: {
            code: 'transport_failed',
            message: 'event stream dropped',
            retryable: true,
            detail: error instanceof Error ? error.message.slice(0, 300) : undefined,
          },
        };
      }

      if (endedByRuntime && !retryable) return;
      if (!request.reconnect) return;
      if (!(await this.backoff(attempt, request))) return;
    }
  }

  async interrupt(input: InterruptRequest): Promise<Result<InterruptReceipt>> {
    const parsed = InterruptRequest.safeParse(input);
    if (!parsed.success) return fail('invalid_request', 'interrupt request failed validation');
    const response = await this.transport.json(
      'POST',
      `/v1/threads/${parsed.data.threadId}/turns/${parsed.data.turnId}/interrupt`,
      {},
    );
    if (!response.ok) return response;
    const body = z
      .object({
        turn: z.object({ id: z.string(), thread_id: z.string(), status: z.string() }).passthrough().optional(),
      })
      .passthrough()
      .safeParse(response.value.json);
    const turn = body.success && body.data.turn ? body.data.turn : response.value.json;
    const check = z
      .object({ id: z.string().min(1), thread_id: z.string().min(1), status: z.string().min(1) })
      .passthrough()
      .safeParse(turn);
    if (!check.success) return fail('schema_drift', 'interrupt receipt did not match the turn contract');
    const threadCheck = verifyThreadId(check.data.thread_id, parsed.data.threadId);
    if (!threadCheck.ok) return threadCheck;
    const turnId = TurnId.safeParse(check.data.id);
    if (!turnId.success) return fail('schema_drift', 'interrupt receipt carried an unknown turn id');
    if (turnId.data !== parsed.data.turnId) {
      return fail('thread_mismatch', 'interrupt acknowledged a different turn');
    }
    return ok({
      threadId: parsed.data.threadId,
      turnId: turnId.data,
      acknowledgedStatus: check.data.status,
    });
  }

  async readHistory(input: HistoryQuery): Promise<Result<HistoryPage>> {
    const parsed = HistoryQuery.safeParse(input);
    if (!parsed.success) return fail('invalid_request', 'history query failed validation');
    const response = await this.transport.json('GET', `/v1/threads/${parsed.data.threadId}/history`);
    if (!response.ok) return response;
    const history = HistoryWire.safeParse(response.value.json);
    if (!history.success) {
      return fail('schema_drift', 'history response did not match the expected contract');
    }
    const threadCheck = verifyThreadId(history.data.runtime_thread_id, parsed.data.threadId);
    if (!threadCheck.ok) return threadCheck;
    const messages = history.data.session?.messages ?? [];
    return ok({
      threadId: parsed.data.threadId,
      messageCount: messages.length,
      messages: messages.slice(-parsed.data.limit),
      documentDigest: history.data.document_digest ?? null,
    });
  }

  async readUsage(input: UsageQuery): Promise<Result<UsageEvidence>> {
    const parsed = UsageQuery.safeParse(input);
    if (!parsed.success) return fail('invalid_request', 'usage query failed validation');
    const response = await this.transport.json('GET', `/v1/threads/${parsed.data.threadId}/usage`);
    if (!response.ok) return response;
    const wire = z
      .object({ thread_id: z.string().min(1) })
      .passthrough()
      .safeParse(response.value.json);
    if (!wire.success) return fail('schema_drift', 'usage response did not include a thread id');
    const threadCheck = verifyThreadId(wire.data.thread_id, parsed.data.threadId);
    if (!threadCheck.ok) return threadCheck;
    return mapUsage(response.value.json, this.now());
  }

  async invokeCapability(input: CapabilityInvocation): Promise<Result<CapabilityResult>> {
    const parsed = CapabilityInvocation.safeParse(input);
    if (!parsed.success) return fail('invalid_request', 'capability request failed validation');
    const discovery = await this.ensureDiscovery();
    if (!discovery.ok) return discovery;
    const routes: Record<Exclude<CapabilityInvocation['name'], 'models.list'>, string> = {
      'runtime.info': '/v1/runtime/info',
      'providers.list': '/v1/providers',
      'skills.list': '/v1/skills',
      'goals.list': '/v1/goals',
      'tasks.list': '/v1/tasks',
    };
    let path: string;
    if (parsed.data.name === 'models.list') {
      let provider = parsed.data.provider;
      if (!provider) {
        const providers = await this.transport.json('GET', '/v1/providers');
        if (!providers.ok) return providers;
        const current = z
          .object({ current: z.string().min(1) })
          .passthrough()
          .safeParse(providers.value.json);
        if (!current.success) return fail('schema_drift', 'provider list did not report a current provider');
        provider = current.data.current;
      }
      path = `/v1/providers/${provider}/models`;
    } else {
      path = routes[parsed.data.name];
    }
    const response = await this.transport.json('GET', path);
    if (!response.ok) return response;
    return ok({ name: parsed.data.name, data: response.value.json });
  }

  private async readThread(threadId: ThreadId): Promise<Result<ThreadRef>> {
    const response = await this.transport.json('GET', `/v1/threads/${threadId}`);
    if (!response.ok) return response;
    const parsed = ThreadEnvelope.safeParse(response.value.json);
    if (!parsed.success) return fail('schema_drift', 'thread response did not match the expected contract');
    const threadCheck = verifyThreadId(parsed.data.thread.id, threadId);
    if (!threadCheck.ok) return threadCheck;
    const profile = mapEffectiveProfile(parsed.data.thread, this.now());
    if (!profile.ok) return profile;
    return ok({
      threadId,
      profile: profile.value,
      latestSeq: parsed.data.latest_seq ?? 0,
    });
  }

  private profileFromThread(raw: unknown, expectedWorkspace?: string): Result<EffectiveProfile> {
    const thread = ThreadEnvelope.safeParse({ thread: raw });
    const direct = thread.success ? thread.data.thread : null;
    const parsed = direct ?? raw;
    const profile = mapEffectiveProfile(parsed, this.now());
    if (!profile.ok) return profile;
    if (expectedWorkspace && profile.value.workspace !== expectedWorkspace) {
      return fail('invalid_request', 'runtime bound the thread to an unexpected workspace', {
        detail: `expected ${expectedWorkspace}, received ${profile.value.workspace}`,
      });
    }
    return profile;
  }

  private async ensureDiscovery(): Promise<Result<EngineDiscovery>> {
    if (this.discovery) return ok(this.discovery);
    return this.discover();
  }

  private async markOutcomeUnknown(record: SubmissionRecord, detail: string): Promise<Result<SubmissionReceipt>> {
    const unknown: SubmissionRecord = {
      ...record,
      state: 'outcome_unknown',
      dispatchedAt: this.now(),
      lastObservedAt: this.now(),
      reconciliation: {
        required: true,
        guidance:
          'The request may have reached the runtime. Reconcile with the operation key before resending; Mona will not retry automatically.',
      },
    };
    await this.safeUpdate(unknown);
    const reconciled = await this.reconcileSubmission({ submissionId: record.id });
    if (reconciled.ok) return ok({ ...reconciled.value, replayed: true });
    return ok(receiptFrom({ ...unknown, reconciliation: { required: true, guidance: detail } }, false));
  }

  private async safeUpdate(record: SubmissionRecord): Promise<void> {
    try {
      await this.journal.update(record);
    } catch {
      // The intent record already exists; a failed state update is surfaced by
      // the next reconcile through the original state.
    }
  }

  private async backoff(
    attempt: number,
    request: { baseDelayMs: number; maxDelayMs: number; signal?: AbortSignal | undefined },
  ): Promise<boolean> {
    const delay = Math.min(request.baseDelayMs * 2 ** Math.max(0, attempt - 1), request.maxDelayMs);
    if (request.signal?.aborted) return false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      request.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    return !request.signal?.aborted;
  }
}

function receiptFrom(record: SubmissionRecord, replayed: boolean): SubmissionReceipt {
  return {
    submissionId: record.id,
    operationKey: record.operationKey,
    threadId: record.threadId,
    turnId: record.turnId,
    state: record.state,
    replayed,
    reconciliation: {
      required: record.reconciliation.required,
      ...(record.reconciliation.guidance ? { guidance: record.reconciliation.guidance } : {}),
    },
  };
}

function stateFromTurnStatus(status: string): SubmissionState | null {
  switch (status) {
    case 'in_progress':
      return 'accepted';
    case 'completed':
      return 'completed';
    case 'interrupted':
      return 'interrupted';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return null;
  }
}

/** The project store arrives at P05; P02/P03 use a deterministic placeholder. */
const PLACEHOLDER_PROJECT_ID = ProjectId.parse(`prj_${'0'.repeat(32)}`);
