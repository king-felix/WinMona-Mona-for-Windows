import { z } from 'zod';
import {
  AgentRun as AgentRunSchema,
  AgentRunUsage,
  FleetRun,
  type FleetStartReceipt,
  type NativeControlReceipt,
  NativeGoal,
  NativeTask,
  type AgentRun,
  type AgentRunArtifact,
  type AgentRunEvent,
  type FleetRunCounts,
} from '@mona/contracts';
import { fail, ok, redact, type Result } from './errors.js';
import type { RuntimeTransport } from './http.js';

/**
 * Read and control the engine's native orchestration surfaces. This client is a
 * thin projection: it never invents a run, a child, a cost, or a lifecycle
 * state. Routes are the ones observed in Codewhale 0.10.2 (ff466b2ed0bf):
 *   GET/PUT /v1/threads/{id}/goal, GET /v1/goals
 *   GET /v1/tasks, POST /v1/tasks/{id}/cancel
 *   GET /v1/agent-runs, POST /v1/agent-runs/{id}/cancel
 *   GET/POST /v1/fleet/runs, /start, /stop, /receipts, workers/{id}/{verb}
 *   GET /v1/threads/{id}/turns/{turnId}/artifacts
 */

const WireCounts = z
  .object({
    runs: z.number().int().nonnegative().optional(),
    queued: z.number().int().nonnegative().optional(),
    running: z.number().int().nonnegative().optional(),
    completed: z.number().int().nonnegative().optional(),
    partial: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
    restarted: z.number().int().nonnegative().optional(),
    escalated: z.number().int().nonnegative().optional(),
    transport_failed: z.number().int().nonnegative().optional(),
    task_failed: z.number().int().nonnegative().optional(),
    verifier_failed: z.number().int().nonnegative().optional(),
    cancelled: z.number().int().nonnegative().optional(),
    stale: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const WireUsage = z
  .object({
    status: z.string().optional(),
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    cost_microusd: z.number().int().nonnegative().optional(),
    note: z.string().optional(),
  })
  .passthrough();

const WireGoal = z
  .object({
    thread_id: z.string().min(1),
    goal_id: z.string().min(1),
    objective: z.string().optional(),
    status: z.string().optional(),
    tokens_used: z.number().int().nonnegative().optional(),
    time_used_seconds: z.number().int().nonnegative().optional(),
    continuation_count: z.number().int().nonnegative().optional(),
    repeated_gap_count: z.number().int().nonnegative().optional(),
    created_at: z.union([z.number(), z.string()]).optional(),
    updated_at: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

const WireTask = z
  .object({
    id: z.string().optional(),
    task_id: z.string().optional(),
    status: z.string().optional(),
    thread_id: z.string().optional(),
    turn_id: z.string().optional(),
    objective: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    instructions: z.string().optional(),
    created_at: z.union([z.number(), z.string()]).optional(),
    updated_at: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

const WireAgentRun = z
  .object({
    spec: z
      .object({
        worker_id: z.string().optional(),
        run_id: z.string().optional(),
        objective: z.string().optional(),
        role: z.string().optional(),
        agent_type: z.string().optional(),
        model: z.string().optional(),
        workspace: z.string().optional(),
        parent_run_id: z.string().optional(),
        spawn_depth: z.number().int().nonnegative().optional(),
        child_route: z
          .object({
            provider_id: z.string().optional(),
            model_id: z.string().optional(),
            effective_reasoning: z.string().optional(),
            requested_reasoning: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    owner_session_id: z.string().optional(),
    runtime_origin_turn_id: z.string().optional(),
    parent_run_id: z.string().optional(),
    actor_kind: z.string().optional(),
    status: z.string().optional(),
    created_at_ms: z.number().int().nonnegative().optional(),
    updated_at_ms: z.number().int().nonnegative().optional(),
    started_at_ms: z.number().int().nonnegative().optional(),
    completed_at_ms: z.number().int().nonnegative().optional(),
    usage: WireUsage.optional(),
    verification: z.object({ status: z.string().optional(), summary: z.string().optional() }).passthrough().optional(),
    artifacts: z
      .array(
        z
          .object({
            kind: z.string().optional(),
            name: z.string().optional(),
            target: z.string().optional(),
            description: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    events: z
      .array(
        z
          .object({
            seq: z.number().int().nonnegative().optional(),
            status: z.string().optional(),
            timestamp_ms: z.number().int().nonnegative().optional(),
            message: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const WireFleetRun = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    lifecycle_status: z.string().optional(),
    target: z.string().optional(),
    workflow: z.object({ id: z.string().optional(), kind: z.string().optional() }).passthrough().optional(),
    roles: z.array(z.string()).optional(),
    task_count: z.number().int().nonnegative().optional(),
    worker_count: z.number().int().nonnegative().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    completed_at: z.string().nullable().optional(),
    status: WireCounts.optional(),
    tasks: z
      .array(
        z
          .object({
            task_id: z.string().optional(),
            status: z.string().optional(),
            leased_to: z.string().nullable().optional(),
            attempts: z.number().int().nonnegative().optional(),
          })
          .passthrough(),
      )
      .optional(),
    worker_specs: z
      .array(
        z
          .object({
            id: z.string().optional(),
            name: z.string().optional(),
            host: z.object({ kind: z.string().optional() }).passthrough().optional(),
            max_concurrent_tasks: z.number().int().nonnegative().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const WireFleetStart = z
  .object({
    action: z.string().optional(),
    execution: z.string().optional(),
    run_id: z.string().optional(),
    target: z.string().optional(),
    leased: z.number().int().nonnegative().optional(),
    queued: z.number().int().nonnegative().optional(),
    worker_ids: z.array(z.string()).optional(),
  })
  .passthrough();

const WireFleetReceipt = z
  .object({
    run_id: z.string().optional(),
    receipts: z.array(z.unknown()).optional(),
  })
  .passthrough();

const WireArtifacts = z
  .object({
    artifacts: z
      .array(
        z
          .object({
            id: z.string().optional(),
            artifact_id: z.string().optional(),
            kind: z.string().optional(),
            name: z.string().optional(),
            media_type: z.string().optional(),
            bytes: z.number().int().nonnegative().optional(),
            digest: z.string().optional(),
            turn_id: z.string().optional(),
            created_at: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const CreateFleetRunInput = z
  .object({
    name: z.string().min(1).max(80),
    projectId: z.string().min(1).max(80),
    instructions: z.string().min(1).max(20_000),
    role: z.string().min(1).max(80).default('worker'),
    maxWorkers: z.number().int().min(1).max(1).default(1),
  })
  .strict();
export type CreateFleetRunInput = z.input<typeof CreateFleetRunInput>;

export type FleetRunHistory = {
  runId: string;
  receipts: unknown[];
};

export type TurnArtifact = {
  id: string;
  kind: string;
  name: string;
  mediaType: string | null;
  bytes: number | null;
  digest: string | null;
  turnId: string | null;
  createdAt: string | null;
};

/** Tolerant access to the native orchestration routes. */
export class NativeOrchestration {
  private readonly transport: RuntimeTransport;

  constructor(transport: RuntimeTransport) {
    this.transport = transport;
  }

  async listGoals(): Promise<Result<NativeGoal[]>> {
    const response = await this.transport.json('GET', '/v1/goals');
    if (!response.ok) return response;
    const body = z
      .object({ goals: z.array(WireGoal) })
      .passthrough()
      .safeParse(response.value.json);
    if (!body.success) return fail('schema_drift', 'goal list did not match the runtime contract');
    return ok(body.data.goals.map(mapGoal));
  }

  async readGoal(threadId: string): Promise<Result<NativeGoal | null>> {
    const response = await this.transport.json('GET', `/v1/threads/${encodeURIComponent(threadId)}/goal`);
    if (!response.ok) {
      if (response.error.code === 'not_found') return ok(null);
      return response;
    }
    const goal = WireGoal.safeParse(response.value.json);
    if (!goal.success) return fail('schema_drift', 'goal response did not match the runtime contract');
    return ok(mapGoal(goal.data));
  }

  /** Creating a native goal starts a goal kickoff turn inside the engine. */
  async createGoal(threadId: string, objective: string): Promise<Result<NativeGoal>> {
    const text = objective.trim();
    if (!text || text.length > 4_000) {
      return fail('invalid_request', 'a goal objective must be 1-4000 characters');
    }
    const response = await this.transport.json('PUT', `/v1/threads/${encodeURIComponent(threadId)}/goal`, {
      objective: text,
    });
    if (!response.ok) return response;
    const goal = WireGoal.safeParse({ thread_id: threadId, ...asRecord(response.value.json) });
    if (!goal.success) return fail('schema_drift', 'created goal did not match the runtime contract');
    return ok(mapGoal(goal.data));
  }

  async completeGoal(threadId: string): Promise<Result<NativeGoal>> {
    const response = await this.transport.json('POST', `/v1/threads/${encodeURIComponent(threadId)}/goal/complete`, {});
    if (!response.ok) return response;
    const goal = WireGoal.safeParse({ thread_id: threadId, ...asRecord(response.value.json) });
    if (!goal.success) return fail('schema_drift', 'completed goal did not match the runtime contract');
    return ok(mapGoal(goal.data));
  }

  async blockGoal(threadId: string, reason: string): Promise<Result<NativeGoal>> {
    const detail = reason.trim().slice(0, 1_000);
    const response = await this.transport.json(
      'POST',
      `/v1/threads/${encodeURIComponent(threadId)}/goal/block`,
      detail ? { reason: detail } : {},
    );
    if (!response.ok) return response;
    const goal = WireGoal.safeParse({ thread_id: threadId, ...asRecord(response.value.json) });
    if (!goal.success) return fail('schema_drift', 'blocked goal did not match the runtime contract');
    return ok(mapGoal(goal.data));
  }

  async listTasks(): Promise<Result<NativeTask[]>> {
    const response = await this.transport.json('GET', '/v1/tasks');
    if (!response.ok) return response;
    const body = z
      .object({ tasks: z.array(WireTask) })
      .passthrough()
      .safeParse(response.value.json);
    if (!body.success) return fail('schema_drift', 'task list did not match the runtime contract');
    return ok(body.data.tasks.map(mapTask).filter((task): task is NativeTask => task !== null));
  }

  async cancelTask(taskId: string): Promise<Result<NativeControlReceipt>> {
    const response = await this.transport.json('POST', `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {});
    if (!response.ok) return response;
    return ok({
      action: 'cancel_task',
      id: taskId,
      acknowledged: response.value.status < 300,
      detail: `Runtime answered HTTP ${response.value.status}. External side effects are not rolled back.`,
    });
  }

  async listAgentRuns(): Promise<Result<AgentRun[]>> {
    const response = await this.transport.json('GET', '/v1/agent-runs');
    if (!response.ok) return response;
    const body = z
      .object({ runs: z.array(WireAgentRun) })
      .passthrough()
      .safeParse(response.value.json);
    if (!body.success) return fail('schema_drift', 'agent-run list did not match the runtime contract');
    return ok(body.data.runs.map(mapAgentRun));
  }

  async cancelAgentRun(runId: string): Promise<Result<NativeControlReceipt>> {
    const response = await this.transport.json('POST', `/v1/agent-runs/${encodeURIComponent(runId)}/cancel`, {});
    if (!response.ok) return response;
    return ok({
      action: 'cancel_agent_run',
      id: runId,
      acknowledged: response.value.status < 300,
      detail: `Runtime answered HTTP ${response.value.status}. The child record stays for inspection.`,
    });
  }

  async listFleetRuns(): Promise<Result<FleetRun[]>> {
    const response = await this.transport.json('GET', '/v1/fleet/runs');
    if (!response.ok) return response;
    const body = z
      .object({ runs: z.array(WireFleetRun) })
      .passthrough()
      .safeParse(response.value.json);
    if (!body.success) return fail('schema_drift', 'fleet-run list did not match the runtime contract');
    return ok(body.data.runs.map(mapFleetRun));
  }

  async readFleetRun(runId: string): Promise<Result<FleetRun>> {
    const response = await this.transport.json('GET', `/v1/fleet/runs/${encodeURIComponent(runId)}`);
    if (!response.ok) return response;
    const wire = WireFleetRun.safeParse(response.value.json);
    if (!wire.success) return fail('schema_drift', 'fleet run did not match the runtime contract');
    return ok(mapFleetRun(wire.data));
  }

  /** Creates one serial run with one task and one worker. No parallel builder. */
  async createFleetRun(input: CreateFleetRunInput): Promise<Result<FleetRun>> {
    const parsed = CreateFleetRunInput.safeParse(input);
    if (!parsed.success) {
      return fail('invalid_request', 'fleet run request failed validation', {
        detail: parsed.error.issues
          .map((issue) => issue.message)
          .join('; ')
          .slice(0, 500),
      });
    }
    const request = parsed.data;
    const response = await this.transport.json('POST', '/v1/fleet/runs', {
      name: request.name,
      target: 'this_computer',
      roles: [{ name: request.role, agent_profile: request.role }],
      max_workers: 1,
      labels: { mona_project: request.projectId },
      workflow: {
        id: request.name,
        kind: 'parallel',
        tasks: [
          {
            id: 'task-1',
            name: request.role,
            instructions: request.instructions,
            worker: { role: request.role },
          },
        ],
      },
    });
    if (!response.ok) return response;
    const body = z.object({ run: WireFleetRun }).passthrough().safeParse(response.value.json);
    if (!body.success) return fail('schema_drift', 'created fleet run did not match the runtime contract');
    return ok(mapFleetRun(body.data.run));
  }

  async startFleetRun(runId: string): Promise<Result<FleetStartReceipt>> {
    const response = await this.transport.json('POST', `/v1/fleet/runs/${encodeURIComponent(runId)}/start`, {});
    if (!response.ok) return response;
    const wire = WireFleetStart.safeParse(response.value.json);
    if (!wire.success) return fail('schema_drift', 'fleet start receipt did not match the runtime contract');
    return ok({
      action: wire.data.action ?? 'start',
      execution: wire.data.execution ?? 'unknown',
      runId: wire.data.run_id ?? runId,
      target: wire.data.target ?? 'unknown',
      leased: wire.data.leased ?? 0,
      queued: wire.data.queued ?? 0,
      workerIds: wire.data.worker_ids ?? [],
    });
  }

  async stopFleetRun(runId: string): Promise<Result<NativeControlReceipt>> {
    const response = await this.transport.json('POST', `/v1/fleet/runs/${encodeURIComponent(runId)}/stop`, {});
    if (!response.ok) return response;
    return ok({
      action: 'stop_fleet_run',
      id: runId,
      acknowledged: response.value.status < 300,
      detail: `Runtime answered HTTP ${response.value.status}. Work already performed is not rolled back.`,
    });
  }

  async interruptFleetWorker(workerId: string): Promise<Result<NativeControlReceipt>> {
    const response = await this.transport.json(
      'POST',
      `/v1/fleet/workers/${encodeURIComponent(workerId)}/interrupt`,
      {},
    );
    if (!response.ok) return response;
    return ok({
      action: 'interrupt_worker',
      id: workerId,
      acknowledged: response.value.status < 300,
      detail: `Runtime answered HTTP ${response.value.status}.`,
    });
  }

  async stopFleetWorker(workerId: string): Promise<Result<NativeControlReceipt>> {
    const response = await this.transport.json('POST', `/v1/fleet/workers/${encodeURIComponent(workerId)}/stop`, {});
    if (!response.ok) return response;
    return ok({
      action: 'stop_worker',
      id: workerId,
      acknowledged: response.value.status < 300,
      detail: `Runtime answered HTTP ${response.value.status}.`,
    });
  }

  async restartFleetWorker(workerId: string): Promise<Result<NativeControlReceipt>> {
    const response = await this.transport.json('POST', `/v1/fleet/workers/${encodeURIComponent(workerId)}/restart`, {});
    if (!response.ok) return response;
    return ok({
      action: 'restart_worker',
      id: workerId,
      acknowledged: response.value.status < 300,
      detail: `Runtime answered HTTP ${response.value.status}.`,
    });
  }

  async listFleetRunReceipts(runId: string): Promise<Result<FleetRunHistory>> {
    const response = await this.transport.json('GET', `/v1/fleet/runs/${encodeURIComponent(runId)}/receipts`);
    if (!response.ok) return response;
    const wire = WireFleetReceipt.safeParse(response.value.json);
    if (!wire.success) return fail('schema_drift', 'fleet receipts did not match the runtime contract');
    return ok({ runId: wire.data.run_id ?? runId, receipts: wire.data.receipts ?? [] });
  }

  async listTurnArtifacts(threadId: string, turnId: string): Promise<Result<TurnArtifact[]>> {
    const response = await this.transport.json(
      'GET',
      `/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/artifacts`,
    );
    if (!response.ok) return response;
    const wire = WireArtifacts.safeParse(response.value.json);
    if (!wire.success) return fail('schema_drift', 'artifact list did not match the runtime contract');
    return ok(
      (wire.data.artifacts ?? []).map((artifact) => ({
        id: artifact.id ?? artifact.artifact_id ?? artifact.name ?? 'artifact',
        kind: artifact.kind ?? 'unknown',
        name: artifact.name ?? artifact.id ?? 'artifact',
        mediaType: artifact.media_type ?? null,
        bytes: artifact.bytes ?? null,
        digest: artifact.digest ?? null,
        turnId: artifact.turn_id ?? turnId,
        createdAt: artifact.created_at ?? null,
      })),
    );
  }
}

// --- mapping --------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isoFromMillis(value: number | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoFromEngineTime(value: number | string | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value < 10_000_000_000 ? value * 1_000 : value;
    return new Date(millis).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return isoFromEngineTime(numeric);
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(0).toISOString();
}

function nullableTime(value: number | string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return isoFromEngineTime(value);
}

export function mapGoal(wire: z.infer<typeof WireGoal>): NativeGoal {
  return NativeGoal.parse({
    threadId: wire.thread_id,
    goalId: wire.goal_id,
    objective: wire.objective ?? '',
    status: wire.status ?? 'unknown',
    tokensUsed: wire.tokens_used ?? 0,
    timeUsedSeconds: wire.time_used_seconds ?? 0,
    continuationCount: wire.continuation_count ?? 0,
    repeatedGapCount: wire.repeated_gap_count ?? 0,
    createdAt: isoFromEngineTime(wire.created_at),
    updatedAt: isoFromEngineTime(wire.updated_at ?? wire.created_at),
  });
}

function mapTask(wire: z.infer<typeof WireTask>): NativeTask | null {
  const id = wire.id ?? wire.task_id;
  if (!id) return null;
  return NativeTask.parse({
    id,
    status: wire.status ?? 'unknown',
    threadId: wire.thread_id ?? null,
    turnId: wire.turn_id ?? null,
    objective: wire.objective ?? wire.title ?? wire.summary ?? wire.instructions ?? null,
    createdAt: nullableTime(wire.created_at),
    updatedAt: nullableTime(wire.updated_at),
  });
}

export function mapAgentRun(wire: z.infer<typeof WireAgentRun>): AgentRun {
  const spec = wire.spec;
  const status = wire.status ?? 'unknown';
  const usage = mapUsage(wire.usage, status);
  const role = spec.role ?? spec.agent_type ?? 'agent';
  const id = spec.worker_id ?? spec.run_id ?? `agent_${role}`;
  const artifacts: AgentRunArtifact[] = (wire.artifacts ?? []).map((artifact) => ({
    kind: artifact.kind ?? 'artifact',
    name: artifact.name ?? artifact.target ?? 'artifact',
    target: artifact.target ?? '',
    description: artifact.description ?? '',
  }));
  const events: AgentRunEvent[] = (wire.events ?? []).map((event) => ({
    seq: event.seq ?? 0,
    status: event.status ?? 'unknown',
    at: isoFromMillis(event.timestamp_ms) ?? new Date(0).toISOString(),
    message: event.message ?? null,
  }));
  return AgentRunSchema.parse({
    id,
    ownerThreadId: wire.owner_session_id ?? '',
    originTurnId: wire.runtime_origin_turn_id ?? null,
    parentRunId: wire.parent_run_id ?? spec.parent_run_id ?? null,
    name: spec.objective?.split('\n')[0]?.slice(0, 200) || role,
    role,
    agentType: spec.agent_type ?? role,
    model: spec.child_route?.model_id ?? spec.model ?? 'unknown',
    provider: spec.child_route?.provider_id ?? 'unknown',
    workspace: spec.workspace ?? '',
    status,
    depth: spec.spawn_depth ?? 0,
    objective: spec.objective ?? '',
    createdAt: isoFromMillis(wire.created_at_ms),
    updatedAt: isoFromMillis(wire.updated_at_ms ?? wire.created_at_ms),
    startedAt: isoFromMillis(wire.started_at_ms),
    completedAt: isoFromMillis(wire.completed_at_ms),
    usage,
    spendIncludedInParent: wire.actor_kind === 'subagent' && usage.status === 'reported',
    verificationStatus: wire.verification?.status ?? null,
    verificationSummary: wire.verification?.summary ?? null,
    artifacts,
    events,
  });
}

function mapUsage(wire: z.infer<typeof WireUsage> | undefined, status: string): AgentRunUsage {
  if (!wire || wire.status !== 'reported') {
    return {
      status: 'unknown',
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costMicros: null,
      note: wire?.note ?? (status === 'completed' ? 'The engine did not report this child’s usage.' : null),
    };
  }
  return AgentRunUsage.parse({
    status: 'reported',
    inputTokens: wire.input_tokens ?? null,
    outputTokens: wire.output_tokens ?? null,
    totalTokens: wire.total_tokens ?? null,
    costMicros: wire.cost_microusd ?? null,
    note: wire.note ?? null,
  });
}

export function mapFleetRun(wire: z.infer<typeof WireFleetRun>): FleetRun {
  const counts: FleetRunCounts = {
    runs: wire.status?.runs ?? 0,
    queued: wire.status?.queued ?? 0,
    running: wire.status?.running ?? 0,
    completed: wire.status?.completed ?? 0,
    partial: wire.status?.partial ?? 0,
    failed: wire.status?.failed ?? 0,
    restarted: wire.status?.restarted ?? 0,
    escalated: wire.status?.escalated ?? 0,
    transportFailed: wire.status?.transport_failed ?? 0,
    taskFailed: wire.status?.task_failed ?? 0,
    verifierFailed: wire.status?.verifier_failed ?? 0,
    cancelled: wire.status?.cancelled ?? 0,
    stale: wire.status?.stale ?? 0,
  };
  const workers = (wire.worker_specs ?? []).map((worker) => ({
    id: worker.id ?? 'worker',
    name: worker.name ?? worker.id ?? 'worker',
    hostKind: worker.host?.kind ?? 'unknown',
    maxConcurrentTasks: worker.max_concurrent_tasks ?? 0,
  }));
  return FleetRun.parse({
    id: wire.id,
    name: wire.name ?? wire.id,
    projectId: wire.labels?.mona_project ?? null,
    lifecycleStatus: wire.lifecycle_status ?? 'unknown',
    target: wire.target ?? 'unknown',
    workflowId: wire.workflow?.id ?? 'unknown',
    workflowKind: wire.workflow?.kind ?? 'unknown',
    roles: wire.roles ?? [],
    taskCount: wire.task_count ?? 0,
    workerCount: wire.worker_count ?? workers.length,
    maxWorkers: workers.length || 1,
    labels: wire.labels ?? {},
    createdAt: wire.created_at ?? null,
    updatedAt: wire.updated_at ?? null,
    completedAt: wire.completed_at ?? null,
    tasks: (wire.tasks ?? []).map((task) => ({
      taskId: task.task_id ?? 'task',
      status: task.status ?? 'unknown',
      leasedTo: task.leased_to ?? null,
      attempts: task.attempts ?? 0,
    })),
    workers,
    counts,
  });
}

/** Redact a native control error before it is shown. */
export function redactNativeDetail(detail: string, token: string): string {
  return redact(detail, [token]);
}
