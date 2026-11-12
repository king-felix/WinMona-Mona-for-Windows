import { describe, expect, it } from 'vitest';
import type { AgentRun } from '@mona/contracts';
import type { EngineAdapter } from '@mona/adapter';
import type { ProjectStore } from '@mona/project-state';
import type { EngineSummary } from './engine-host.js';
import { AgentObservatoryService } from './agent-observatory.js';

const PROJECT = {
  id: 'prj_1',
  label: 'Demo',
  canonicalPath: 'C:\\proj',
  createdAt: '2026-11-12T08:00:00Z',
  updatedAt: '2026-11-12T08:00:00Z',
};

function summary(overrides: Partial<EngineSummary> = {}): EngineSummary {
  return {
    state: 'connected',
    detail: 'ready',
    workspace: 'C:\\proj',
    pid: 1,
    endpoint: 'http://127.0.0.1:1234',
    compatibility: 'qualified',
    descriptors: [],
    ...overrides,
  };
}

const reportedChild: AgentRun = {
  id: 'agent_1',
  ownerThreadId: 'thr_11111111111111111111111111111111',
  originTurnId: 'turn_1',
  parentRunId: null,
  name: 'explore',
  role: 'explore',
  agentType: 'explore',
  model: 'deepseek-flash',
  provider: 'deepseek',
  workspace: 'C:\\proj',
  status: 'completed',
  depth: 1,
  objective: 'Reply OK',
  createdAt: '2026-11-12T08:00:01Z',
  updatedAt: '2026-11-12T08:00:02Z',
  startedAt: '2026-11-12T08:00:01Z',
  completedAt: '2026-11-12T08:00:02Z',
  usage: {
    status: 'reported' as const,
    inputTokens: 7_096,
    outputTokens: 14,
    totalTokens: 7_110,
    costMicros: 678,
    note: 'Provider reported 7110 tokens.',
  },
  spendIncludedInParent: true,
  verificationStatus: 'self_report_only',
  verificationSummary: 'verify before relying',
  artifacts: [],
  events: [{ seq: 3, status: 'completed', at: '2026-11-12T08:00:02Z', message: 'completed' }],
};

const goal = {
  threadId: 'thr_11111111111111111111111111111111',
  goalId: 'goal-1',
  objective: 'Ship the thing',
  status: 'active',
  tokensUsed: 0,
  timeUsedSeconds: 0,
  continuationCount: 0,
  repeatedGapCount: 0,
  createdAt: '2026-11-12T08:00:00Z',
  updatedAt: '2026-11-12T08:00:00Z',
};

const fleet = {
  id: 'fleet-1',
  name: 'probe',
  projectId: 'prj_1',
  lifecycleStatus: 'queued',
  target: 'this_computer',
  workflowId: 'probe',
  workflowKind: 'parallel',
  roles: ['general'],
  taskCount: 1,
  workerCount: 1,
  maxWorkers: 1,
  labels: { mona_project: 'prj_1' },
  createdAt: '2026-11-12T08:00:00Z',
  updatedAt: '2026-11-12T08:00:00Z',
  completedAt: null,
  tasks: [{ taskId: 't1', status: 'enqueued', leasedTo: null, attempts: 0 }],
  workers: [{ id: 'fleet-1-local-1', name: 'Local worker 1', hostKind: 'local', maxConcurrentTasks: 1 }],
  counts: {
    runs: 1,
    queued: 1,
    running: 0,
    completed: 0,
    partial: 0,
    failed: 0,
    restarted: 0,
    escalated: 0,
    transportFailed: 0,
    taskFailed: 0,
    verifierFailed: 0,
    cancelled: 0,
    stale: 0,
  },
};

function makeService(options: {
  child?: AgentRun;
  threadCost?:
    { status: 'known'; usd: number; source: string; rateRevision: string } | { status: 'unknown'; reason: string };
  monaQueue?: { runId: string; at: string } | null;
  start?: () => unknown;
  readRun?: () => unknown;
  engine?: EngineSummary;
}) {
  const child = options.child ?? reportedChild;
  const orchestration = {
    listGoals: async () => ({ ok: true as const, value: [goal] }),
    listTasks: async () => ({ ok: true as const, value: [] }),
    listAgentRuns: async () => ({ ok: true as const, value: [child] }),
    listFleetRuns: async () => ({ ok: true as const, value: [fleet] }),
    createFleetRun: async () => ({ ok: true as const, value: fleet }),
    startFleetRun: async () =>
      options.start
        ? options.start()
        : {
            ok: true as const,
            value: {
              action: 'start',
              execution: 'scheduled',
              runId: 'fleet-1',
              target: 'this_computer',
              leased: 0,
              queued: 1,
              workerIds: ['fleet-1-local-1'],
            },
          },
    readFleetRun: async () => (options.readRun ? options.readRun() : { ok: true as const, value: fleet }),
    stopFleetRun: async () => ({
      ok: true as const,
      value: { action: 'stop_fleet_run', id: 'fleet-1', acknowledged: true, detail: 'stopped' },
    }),
    interruptFleetWorker: async () => ({
      ok: true as const,
      value: { action: 'interrupt_worker', id: 'w', acknowledged: true, detail: 'ok' },
    }),
    cancelAgentRun: async () => ({
      ok: true as const,
      value: { action: 'cancel_agent_run', id: 'agent_1', acknowledged: true, detail: 'ok' },
    }),
    cancelTask: async () => ({
      ok: true as const,
      value: { action: 'cancel_task', id: 't1', acknowledged: true, detail: 'ok' },
    }),
    createGoal: async () => ({
      ok: true as const,
      value: { ...goal, goalId: 'goal-2' },
    }),
    completeGoal: async () => ({ ok: true as const, value: { ...goal, status: 'complete' } }),
  };
  const adapter = {
    orchestration: () => orchestration,
    readUsage: async () => ({
      ok: true as const,
      value: {
        buckets: { inputMissTokens: 0, cacheHitTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        cost: options.threadCost ?? {
          status: 'known' as const,
          usd: 0.005731872,
          source: 'engine_priced',
          rateRevision: 'r1',
        },
        complete: true,
        capturedAt: '2026-11-12T08:00:03Z',
        turnId: null,
      },
    }),
  } as unknown as EngineAdapter;
  const store = {
    getProject: async (id: string) => (id === PROJECT.id ? PROJECT : null),
  } as unknown as ProjectStore;
  return new AgentObservatoryService({
    store,
    engine: {
      summary: () => options.engine ?? summary(),
      adapter: () => adapter,
    },
    now: () => new Date('2026-11-12T09:00:00Z'),
    monaQueueActive: () => options.monaQueue ?? null,
  });
}

describe('agent observatory', () => {
  it('builds a truthful graph and does not add child spend twice', async () => {
    const service = makeService({});
    const result = await service.view({ projectId: 'prj_1', threadId: 'thr_11111111111111111111111111111111' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ownership.owner).toBe('native_fleet');
    expect(result.data.nodes.find((node) => node.id === 'thread:thr_11111111111111111111111111111111')).toBeDefined();
    const childNode = result.data.nodes.find((node) => node.id === 'agent:agent_1');
    expect(childNode?.spendIncludedInParent).toBe(true);
    expect(childNode?.spend.status).toBe('known');
    expect(result.data.spend.doubleCountAvoided).toBe(true);
    expect(result.data.spend.aggregate.status).toBe('known');
    if (result.data.spend.aggregate.status === 'known') {
      expect(result.data.spend.aggregate.usd).toBeCloseTo(0.005731872, 9);
    }
    expect(result.data.spend.childrenKnownMicros).toBe(678);
  });

  it('keeps an unknown child price unknown and refuses to sum into an unknown parent', async () => {
    const unknownChild = {
      ...reportedChild,
      usage: {
        status: 'unknown' as const,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costMicros: null,
        note: 'no usage reported',
      },
      spendIncludedInParent: false,
    };
    const service = makeService({
      child: unknownChild,
      threadCost: { status: 'unknown', reason: 'no thread price' },
    });
    const result = await service.view({ projectId: 'prj_1', threadId: 'thr_11111111111111111111111111111111' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const childNode = result.data.nodes.find((node) => node.id === 'agent:agent_1');
    expect(childNode?.spend.status).toBe('unknown');
    expect(result.data.spend.aggregate.status).toBe('unknown');
    expect(result.data.spend.childrenKnownMicros).toBeNull();
  });

  it('reports a scheduled start with no observed lease instead of claiming execution', async () => {
    const service = makeService({});
    const started = await service.startFleetRun({ projectId: 'prj_1', runId: 'fleet-1' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.receipt.execution).toBe('scheduled');
    expect(started.data.observation.leased).toBe(0);
    expect(started.data.observation.detail).toContain('no worker lease was observed');
  });

  it('refuses a native run while Mona’s queue owns the active turn', async () => {
    const service = makeService({ monaQueue: { runId: 'turn-live', at: '2026-11-12T08:59:00Z' } });
    const created = await service.createFleetRun({
      projectId: 'prj_1',
      name: 'probe',
      instructions: 'Reply OK',
      role: 'worker',
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.message).toContain('Mona’s queue owns');
  });

  it('marks the observatory disconnected when the runtime serves another workspace', async () => {
    const service = makeService({ engine: summary({ workspace: 'C:\\other' }) });
    const result = await service.view({ projectId: 'prj_1', threadId: 'thr_11111111111111111111111111111111' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.connected).toBe(false);
    expect(result.data.caveats[0]).toContain('connected');
  });
});
