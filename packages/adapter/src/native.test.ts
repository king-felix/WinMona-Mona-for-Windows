import { describe, expect, it } from 'vitest';
import type { RuntimeTransport, TransportOptions, TransportResponse } from './http.js';
import type { Result } from './errors.js';
import { NativeOrchestration, mapAgentRun, mapFleetRun, mapGoal } from './native.js';

type Call = { method: string; path: string; body: unknown };

class FakeTransport implements RuntimeTransport {
  readonly calls: Call[] = [];
  constructor(private readonly routes: Record<string, unknown>) {}

  async json(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    _options?: TransportOptions,
  ): Promise<Result<TransportResponse>> {
    this.calls.push({ method, path, body });
    const key = `${method} ${path.split('?')[0]}`;
    const match = this.routes[key];
    if (match === undefined) return { ok: false, error: { code: 'not_found', message: 'not found', retryable: false } };
    const json = typeof match === 'function' ? (match as (body: unknown) => unknown)(body) : match;
    return { ok: true, value: { status: 200, json, bytes: JSON.stringify(json).length } };
  }

  async stream(): Promise<Result<AsyncIterable<Uint8Array>>> {
    return { ok: false, error: { code: 'transport_failed', message: 'unused', retryable: false } };
  }
}

const agentWire = {
  spec: {
    worker_id: 'agent_b659284a',
    run_id: 'agent_b659284a',
    objective: 'Reply with exactly the word OK and nothing else. Do not use tools.',
    role: 'explore',
    agent_type: 'explore',
    model: 'deepseek-flash',
    workspace: 'X:\\work',
    spawn_depth: 1,
    child_route: {
      provider_id: 'deepseek',
      model_id: 'deepseek-flash',
      effective_reasoning: 'high',
    },
  },
  owner_session_id: 'thr_2291035a27c24f958f1c4d493f80f650',
  runtime_origin_turn_id: 'turn_dd7b68027d9c4a59b9afd77a5377608d',
  actor_kind: 'subagent',
  status: 'completed',
  created_at_ms: 1794472672834,
  updated_at_ms: 1794472674343,
  started_at_ms: 1794472672841,
  completed_at_ms: 1794472674343,
  usage: {
    status: 'reported',
    input_tokens: 7096,
    output_tokens: 14,
    total_tokens: 7110,
    cost_microusd: 678,
    note: 'Provider reported 7110 tokens for this worker.',
  },
  verification: { status: 'self_report_only', summary: 'No verified command or test receipt is attached.' },
  artifacts: [{ kind: 'transcript', name: 'transcript_handle', target: 'agent:agent_b659284a', description: 'x' }],
  events: [
    { seq: 1, status: 'starting', timestamp_ms: 1794472672834, message: 'starting' },
    { seq: 3, status: 'completed', timestamp_ms: 1794472674343, message: 'completed', step: 1 },
  ],
};

describe('native orchestration mapping', () => {
  it('maps a completed child and marks its spend as included in the parent total', () => {
    const run = mapAgentRun(agentWire);
    expect(run.id).toBe('agent_b659284a');
    expect(run.ownerThreadId).toBe('thr_2291035a27c24f958f1c4d493f80f650');
    expect(run.originTurnId).toBe('turn_dd7b68027d9c4a59b9afd77a5377608d');
    expect(run.usage.status).toBe('reported');
    expect(run.usage.costMicros).toBe(678);
    expect(run.spendIncludedInParent).toBe(true);
    expect(run.events.map((event) => event.status)).toEqual(['starting', 'completed']);
    expect(run.artifacts[0]?.target).toBe('agent:agent_b659284a');
  });

  it('keeps unknown child usage unknown instead of coercing it to zero', () => {
    const run = mapAgentRun({
      ...agentWire,
      status: 'running',
      completed_at_ms: undefined,
      usage: { status: 'unknown' },
      actor_kind: 'subagent',
    });
    expect(run.usage.status).toBe('unknown');
    expect(run.usage.costMicros).toBeNull();
    expect(run.spendIncludedInParent).toBe(false);
  });

  it('maps a goal timestamp reported in seconds', () => {
    const goal = mapGoal({
      thread_id: 'thr_x',
      goal_id: 'goal-1',
      objective: 'Ship it',
      status: 'active',
      tokens_used: 12,
      time_used_seconds: 3,
      continuation_count: 1,
      repeated_gap_count: 0,
      created_at: 1794472721,
      updated_at: 1794472721,
    });
    expect(goal.createdAt).toBe('2026-11-12T08:38:41.000Z');
    expect(goal.objective).toBe('Ship it');
  });

  it('maps a fleet run with its task and worker records', () => {
    const run = mapFleetRun({
      id: 'fleet-b9c79c28',
      name: 'mona-p15-probe',
      lifecycle_status: 'running',
      target: 'this_computer',
      workflow: { id: 'mona-p15-probe', kind: 'parallel' },
      roles: ['general'],
      task_count: 1,
      worker_count: 1,
      labels: { source: 'mona-p15' },
      created_at: '2026-11-12T08:34:17Z',
      updated_at: '2026-11-12T08:34:17Z',
      completed_at: null,
      status: { runs: 1, queued: 1, running: 0, completed: 0, workers: {} },
      tasks: [{ task_id: 't1', status: 'enqueued', leased_to: null, attempts: 0 }],
      worker_specs: [
        { id: 'fleet-b9c79c28-local-1', name: 'Local worker 1', host: { kind: 'local' }, max_concurrent_tasks: 1 },
      ],
    });
    expect(run.id).toBe('fleet-b9c79c28');
    expect(run.tasks[0]?.status).toBe('enqueued');
    expect(run.workers[0]?.hostKind).toBe('local');
    expect(run.counts.queued).toBe(1);
    expect(run.maxWorkers).toBe(1);
  });
});

describe('native orchestration client', () => {
  it('creates one serial fleet run with an explicit project label', async () => {
    const transport = new FakeTransport({
      'POST /v1/fleet/runs': {
        run: {
          id: 'fleet-new',
          name: 'review',
          lifecycle_status: 'queued',
          target: 'this_computer',
          workflow: { id: 'review', kind: 'parallel' },
          roles: ['general'],
          task_count: 1,
          worker_count: 1,
          labels: { mona_project: 'prj_1' },
          created_at: '2026-11-12T08:00:00Z',
          updated_at: '2026-11-12T08:00:00Z',
          tasks: [{ task_id: 'task-1', status: 'enqueued', leased_to: null, attempts: 0 }],
          worker_specs: [],
          status: { runs: 1, queued: 1 },
        },
      },
    });
    const client = new NativeOrchestration(transport);
    const created = await client.createFleetRun({
      name: 'review',
      projectId: 'prj_1',
      instructions: 'Reply OK',
      role: 'worker',
      maxWorkers: 1,
    });
    expect(created.ok).toBe(true);
    const body = transport.calls[0]?.body as Record<string, unknown>;
    expect(body.max_workers).toBe(1);
    expect(body.target).toBe('this_computer');
    expect((body.labels as Record<string, string>).mona_project).toBe('prj_1');
    const workflow = body.workflow as { tasks: Array<{ instructions: string }> };
    expect(workflow.tasks).toHaveLength(1);
    expect(workflow.tasks[0]?.instructions).toBe('Reply OK');
  });

  it('returns the engine start receipt without claiming a lease', async () => {
    const transport = new FakeTransport({
      'POST /v1/fleet/runs/fleet-1/start': {
        action: 'start',
        execution: 'scheduled',
        run_id: 'fleet-1',
        target: 'this_computer',
        leased: 0,
        queued: 1,
        worker_ids: ['fleet-1-local-1'],
      },
    });
    const client = new NativeOrchestration(transport);
    const started = await client.startFleetRun('fleet-1');
    expect(started.ok).toBe(true);
    if (started.ok) {
      expect(started.value.execution).toBe('scheduled');
      expect(started.value.leased).toBe(0);
      expect(started.value.workerIds).toEqual(['fleet-1-local-1']);
    }
  });

  it('turns a missing per-thread goal into null, not an error', async () => {
    const transport = new FakeTransport({});
    const client = new NativeOrchestration(transport);
    const goal = await client.readGoal('thr_missing');
    expect(goal.ok).toBe(true);
    if (goal.ok) expect(goal.value).toBeNull();
  });
});
