import {
  errorResult,
  ThreadId,
  type AgentNode,
  type CostEvidence,
  type FleetStartReceipt,
  type ObservatoryView,
  type OwnershipView,
} from '@mona/contracts';
import type { EngineAdapter } from '@mona/adapter';
import type { ProjectStore } from '@mona/project-state';
import type { EngineSummary } from './engine-host.js';

export type ObservatoryEnginePort = {
  summary(): EngineSummary;
  adapter(): EngineAdapter | null;
};

export type ObservatoryDeps = {
  store: ProjectStore;
  engine: ObservatoryEnginePort;
  now?: () => Date;
  /** True while Mona's own queue has an active turn for this project. */
  monaQueueActive?: (projectId: string) => { runId: string; at: string } | null;
};

type Success<T> = { ok: true; data: T };
type Failure = { ok: false; error: ReturnType<typeof errorResult> };
type ServiceResult<T> = Success<T> | Failure;

export type FleetControlObservation = {
  leased: number;
  runningTasks: number;
  detail: string;
};

/**
 * Observes and controls native goals, fleets, workflows and agent children. It
 * does not schedule: every start is handed to the engine, and Mona's queue is
 * told not to dispatch while a native owner is active (spec 10.3).
 */
export class AgentObservatoryService {
  private readonly store: ProjectStore;
  private readonly engine: ObservatoryEnginePort;
  private readonly now: () => Date;
  private readonly monaQueueActive: (projectId: string) => { runId: string; at: string } | null;
  private readonly ownership = new Map<string, OwnershipView>();
  private readonly diagnostics = new Map<string, string[]>();

  constructor(deps: ObservatoryDeps) {
    this.store = deps.store;
    this.engine = deps.engine;
    this.now = deps.now ?? (() => new Date());
    this.monaQueueActive = deps.monaQueueActive ?? (() => null);
  }

  async view(input: { projectId: string; threadId: string | null }): Promise<ServiceResult<ObservatoryView>> {
    const project = await this.store.getProject(input.projectId);
    if (!project) return { ok: false, error: errorResult('not_found', 'That project is not in the catalog.') };
    const summary = this.engine.summary();
    const connected = summary.state === 'connected' && summary.workspace === project.canonicalPath;
    const adapter = this.engine.adapter();
    const capturedAt = this.now().toISOString();
    if (!connected || !adapter) {
      return {
        ok: true,
        data: this.emptyView(
          input,
          capturedAt,
          connected
            ? 'The engine adapter is not available yet; no native run can be read.'
            : `The engine is ${summary.state}. ${summary.detail}`,
        ),
      };
    }

    const native = adapter.orchestration();
    const caveats: string[] = [];
    const [goals, tasks, agentRuns, fleetRuns, usage] = await Promise.all([
      native.listGoals(),
      native.listTasks(),
      native.listAgentRuns(),
      native.listFleetRuns(),
      input.threadId ? adapter.readUsage({ threadId: ThreadId.parse(input.threadId) }) : Promise.resolve(null),
    ]);

    const goalList = goals.ok ? goals.value : [];
    if (!goals.ok) caveats.push(`Native goals are unavailable: ${goals.error.code}.`);
    const taskList = tasks.ok ? tasks.value : [];
    if (!tasks.ok) caveats.push(`Native tasks are unavailable: ${tasks.error.code}.`);
    const runs = agentRuns.ok
      ? agentRuns.value.filter(
          (run) =>
            (input.threadId !== null && run.ownerThreadId === input.threadId) ||
            (input.threadId === null && run.workspace === project.canonicalPath),
        )
      : [];
    if (!agentRuns.ok) caveats.push(`Agent runs are unavailable: ${agentRuns.error.code}.`);
    const fleets = fleetRuns.ok
      ? fleetRuns.value.filter((run) => run.projectId === input.projectId || run.projectId === null)
      : [];
    if (!fleetRuns.ok) caveats.push(`Fleet runs are unavailable: ${fleetRuns.error.code}.`);
    if (fleetRuns.ok && fleetRuns.value.some((run) => run.projectId === null)) {
      caveats.push('Some fleet runs carry no Mona project label; their workspace is not asserted here.');
    }

    const threadCost: CostEvidence = usage?.ok
      ? usage.value.cost
      : {
          status: 'unknown',
          reason: input.threadId ? 'The runtime did not report thread usage.' : 'No thread is selected.',
        };
    const spend = summarizeSpend(threadCost, runs);
    const ownership = this.recomputeOwnership(input.projectId, {
      fleets,
      runs,
      goals: goalList,
    });

    return {
      ok: true,
      data: {
        projectId: input.projectId,
        threadId: input.threadId,
        connected: true,
        capturedAt,
        ownership,
        spend,
        nodes: buildNodes(input.threadId, goalList, runs, fleets, threadCost),
        goals: goalList,
        tasks: taskList,
        fleetRuns: fleets,
        agentRuns: runs,
        artifacts: runs.flatMap((run) => run.artifacts),
        caveats,
        diagnostics: [...(this.diagnostics.get(input.projectId) ?? [])],
      },
    };
  }

  /** True when an engine-native owner is scheduling work for this project. */
  nativeDispatcherActive(projectId: string): boolean {
    const owner = this.ownership.get(projectId)?.owner;
    return owner === 'native_fleet' || owner === 'native_goal' || owner === 'native_agent';
  }

  async createFleetRun(input: {
    projectId: string;
    name: string;
    instructions: string;
    role: string;
  }): Promise<ServiceResult<{ runId: string; detail: string }>> {
    const preflight = await this.preflight(input.projectId);
    if ('error' in preflight) return { ok: false, error: preflight.error };
    const conflict = this.conflict(input.projectId, 'native_fleet');
    if (conflict) return { ok: false, error: errorResult('invalid_request', conflict) };
    const created = await preflight.adapter.orchestration().createFleetRun({
      projectId: input.projectId,
      name: input.name,
      instructions: input.instructions,
      role: input.role,
      maxWorkers: 1,
    });
    if (!created.ok) {
      return { ok: false, error: errorResult(created.error.code, created.error.message, created.error.retryable) };
    }
    this.setOwnership(input.projectId, {
      owner: 'native_fleet',
      runId: created.value.id,
      detail: 'A native fleet run is queued. Start it when you want the engine to lease a worker.',
      since: this.now().toISOString(),
    });
    this.note(input.projectId, `created native fleet run ${created.value.id} with one serial task`);
    return {
      ok: true,
      data: {
        runId: created.value.id,
        detail: 'The engine created the run but has not started a worker. Start it explicitly.',
      },
    };
  }

  async startFleetRun(input: {
    projectId: string;
    runId: string;
  }): Promise<ServiceResult<{ receipt: FleetStartReceipt; observation: FleetControlObservation }>> {
    const preflight = await this.preflight(input.projectId);
    if ('error' in preflight) return { ok: false, error: preflight.error };
    const conflict = this.conflict(input.projectId, 'native_fleet', input.runId);
    if (conflict) return { ok: false, error: errorResult('invalid_request', conflict) };
    const native = preflight.adapter.orchestration();
    const started = await native.startFleetRun(input.runId);
    if (!started.ok) {
      return { ok: false, error: errorResult(started.error.code, started.error.message, started.error.retryable) };
    }
    this.setOwnership(input.projectId, {
      owner: 'native_fleet',
      runId: input.runId,
      detail: `Engine ${started.value.execution}; ${started.value.leased} leased, ${started.value.queued} queued.`,
      since: this.now().toISOString(),
    });
    const observation = await this.observeLease(preflight.adapter, input.runId);
    this.note(input.projectId, `start ${input.runId}: ${observation.detail}`);
    return { ok: true, data: { receipt: started.value, observation } };
  }

  async stopFleetRun(input: { projectId: string; runId: string }): Promise<ServiceResult<{ acknowledged: boolean }>> {
    const preflight = await this.preflight(input.projectId);
    if ('error' in preflight) return { ok: false, error: preflight.error };
    const stopped = await preflight.adapter.orchestration().stopFleetRun(input.runId);
    if (!stopped.ok) {
      return { ok: false, error: errorResult(stopped.error.code, stopped.error.message, stopped.error.retryable) };
    }
    if (this.ownership.get(input.projectId)?.runId === input.runId) this.clearOwnership(input.projectId);
    this.note(input.projectId, `stop ${input.runId}: ${stopped.value.detail}`);
    return { ok: true, data: { acknowledged: stopped.value.acknowledged } };
  }

  async interruptWorker(input: {
    projectId: string;
    workerId: string;
  }): Promise<ServiceResult<{ acknowledged: boolean }>> {
    const preflight = await this.preflight(input.projectId);
    if ('error' in preflight) return { ok: false, error: preflight.error };
    const result = await preflight.adapter.orchestration().interruptFleetWorker(input.workerId);
    if (!result.ok) {
      return { ok: false, error: errorResult(result.error.code, result.error.message, result.error.retryable) };
    }
    this.note(input.projectId, `interrupt worker ${input.workerId}`);
    return { ok: true, data: { acknowledged: result.value.acknowledged } };
  }

  async cancelAgentRun(input: { projectId: string; runId: string }): Promise<ServiceResult<{ acknowledged: boolean }>> {
    const preflight = await this.preflight(input.projectId);
    if ('error' in preflight) return { ok: false, error: preflight.error };
    const result = await preflight.adapter.orchestration().cancelAgentRun(input.runId);
    if (!result.ok) {
      return { ok: false, error: errorResult(result.error.code, result.error.message, result.error.retryable) };
    }
    this.note(input.projectId, `cancel agent run ${input.runId}`);
    return { ok: true, data: { acknowledged: result.value.acknowledged } };
  }

  async cancelTask(input: { projectId: string; taskId: string }): Promise<ServiceResult<{ acknowledged: boolean }>> {
    const preflight = await this.preflight(input.projectId);
    if ('error' in preflight) return { ok: false, error: preflight.error };
    const result = await preflight.adapter.orchestration().cancelTask(input.taskId);
    if (!result.ok) {
      return { ok: false, error: errorResult(result.error.code, result.error.message, result.error.retryable) };
    }
    this.note(input.projectId, `cancel task ${input.taskId}`);
    return { ok: true, data: { acknowledged: result.value.acknowledged } };
  }

  async createGoal(input: {
    projectId: string;
    threadId: string;
    objective: string;
  }): Promise<ServiceResult<{ goalId: string; detail: string }>> {
    const preflight = await this.preflight(input.projectId);
    if ('error' in preflight) return { ok: false, error: preflight.error };
    const conflict = this.conflict(input.projectId, 'native_goal');
    if (conflict) return { ok: false, error: errorResult('invalid_request', conflict) };
    const goal = await preflight.adapter.orchestration().createGoal(input.threadId, input.objective);
    if (!goal.ok) return { ok: false, error: errorResult(goal.error.code, goal.error.message, goal.error.retryable) };
    this.setOwnership(input.projectId, {
      owner: 'native_goal',
      runId: goal.value.goalId,
      detail: 'The engine started a goal kickoff turn. Mona will not dispatch the same work.',
      since: this.now().toISOString(),
    });
    this.note(input.projectId, `created native goal ${goal.value.goalId}`);
    return {
      ok: true,
      data: {
        goalId: goal.value.goalId,
        detail:
          'A native goal starts a goal kickoff turn inside the engine. Mona observes it and does not submit a second turn.',
      },
    };
  }

  async completeGoal(input: {
    projectId: string;
    threadId: string;
  }): Promise<ServiceResult<{ acknowledged: boolean }>> {
    const preflight = await this.preflight(input.projectId);
    if ('error' in preflight) return { ok: false, error: preflight.error };
    const goal = await preflight.adapter.orchestration().completeGoal(input.threadId);
    if (!goal.ok) return { ok: false, error: errorResult(goal.error.code, goal.error.message, goal.error.retryable) };
    if (this.ownership.get(input.projectId)?.runId === goal.value.goalId) this.clearOwnership(input.projectId);
    this.note(input.projectId, `completed native goal ${goal.value.goalId}`);
    return { ok: true, data: { acknowledged: true } };
  }

  // --- internals ----------------------------------------------------------

  private async preflight(
    projectId: string,
  ): Promise<{ adapter: EngineAdapter; projectPath: string } | { error: ReturnType<typeof errorResult> }> {
    const project = await this.store.getProject(projectId);
    if (!project) return { error: errorResult('not_found', 'That project is not in the catalog.') };
    const summary = this.engine.summary();
    if (summary.state !== 'connected') {
      return { error: errorResult('engine_unavailable', 'The engine is not connected for this project.') };
    }
    if (summary.workspace !== project.canonicalPath) {
      return {
        error: errorResult(
          'invalid_request',
          `The runtime is serving ${summary.workspace ?? 'another workspace'}. Native runs must use this project's runtime.`,
        ),
      };
    }
    const adapter = this.engine.adapter();
    if (!adapter) return { error: errorResult('engine_unavailable', 'No live runtime adapter is available.') };
    return { adapter, projectPath: project.canonicalPath };
  }

  private conflict(projectId: string, next: OwnershipView['owner'], runId?: string): string | null {
    const owner = this.ownership.get(projectId);
    if (!owner || owner.owner === 'none') {
      const queue = this.monaQueueActive(projectId);
      if (queue) {
        return 'Mona’s queue owns the active turn for this project. Wait for it to finish before starting native work.';
      }
      return null;
    }
    if (owner.owner === next && (runId === undefined || owner.runId === runId)) return null;
    if (owner.owner === 'mona_queue') {
      return 'Mona’s queue owns the active turn for this project. Wait for it to finish before starting native work.';
    }
    return `${owner.owner} already owns scheduling for this project${owner.runId ? ` (${owner.runId})` : ''}.`;
  }

  private recomputeOwnership(
    projectId: string,
    state: {
      fleets: ObservatoryView['fleetRuns'];
      runs: ObservatoryView['agentRuns'];
      goals: ObservatoryView['goals'];
    },
  ): OwnershipView {
    const runningFleet = state.fleets.find((run) =>
      ['queued', 'running', 'scheduled', 'starting'].includes(run.lifecycleStatus),
    );
    if (runningFleet) {
      return this.setOwnership(projectId, {
        owner: 'native_fleet',
        runId: runningFleet.id,
        detail: `Native fleet run is ${runningFleet.lifecycleStatus}.`,
        since: this.ownership.get(projectId)?.runId === runningFleet.id ? null : this.now().toISOString(),
      });
    }
    const runningAgent = state.runs.find((run) => ['running', 'starting'].includes(run.status));
    if (runningAgent) {
      return this.setOwnership(projectId, {
        owner: 'native_agent',
        runId: runningAgent.id,
        detail: `Native child ${runningAgent.role} is ${runningAgent.status}.`,
        since: this.ownership.get(projectId)?.runId === runningAgent.id ? null : this.now().toISOString(),
      });
    }
    const activeGoal = state.goals.find((goal) => goal.status === 'active');
    if (activeGoal) {
      return this.setOwnership(projectId, {
        owner: 'native_goal',
        runId: activeGoal.goalId,
        detail: 'A native goal is active on this thread.',
        since: this.ownership.get(projectId)?.runId === activeGoal.goalId ? null : this.now().toISOString(),
      });
    }
    const queue = this.monaQueueActive(projectId);
    if (queue) {
      return this.setOwnership(projectId, {
        owner: 'mona_queue',
        runId: queue.runId,
        detail: 'Mona’s queue owns the active turn.',
        since: queue.at,
      });
    }
    return this.setOwnership(projectId, {
      owner: 'none',
      runId: null,
      detail: 'No execution owner is active. Mona’s queue starts only when you submit.',
      since: null,
    });
  }

  private setOwnership(projectId: string, next: OwnershipView): OwnershipView {
    const previous = this.ownership.get(projectId);
    const since =
      next.since ?? (previous?.owner === next.owner && previous?.runId === next.runId ? previous.since : null);
    const value: OwnershipView = { ...next, since: since ?? null };
    this.ownership.set(projectId, value);
    return value;
  }

  private clearOwnership(projectId: string): void {
    this.ownership.set(projectId, {
      owner: 'none',
      runId: null,
      detail: 'No execution owner is active. Mona’s queue starts only when you submit.',
      since: null,
    });
  }

  private async observeLease(adapter: EngineAdapter, runId: string): Promise<FleetControlObservation> {
    const native = adapter.orchestration();
    const deadline = Date.now() + 1_500;
    let lastLeased = 0;
    let lastRunning = 0;
    while (Date.now() < deadline) {
      const run = await native.readFleetRun(runId);
      if (!run.ok)
        return {
          leased: lastLeased,
          runningTasks: lastRunning,
          detail: `Run could not be re-read: ${run.error.code}.`,
        };
      lastLeased = run.value.tasks.filter((task) => task.leasedTo !== null).length;
      lastRunning = run.value.tasks.filter((task) => task.status === 'running').length;
      if (lastLeased > 0 || lastRunning > 0) {
        return {
          leased: lastLeased,
          runningTasks: lastRunning,
          detail: `Observed ${lastLeased} leased and ${lastRunning} running task(s).`,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return {
      leased: lastLeased,
      runningTasks: lastRunning,
      detail:
        'The engine accepted the start but no worker lease was observed. This runtime build did not start a local fleet supervisor; the run remains queued.',
    };
  }

  private note(projectId: string, line: string): void {
    const existing = this.diagnostics.get(projectId) ?? [];
    existing.push(`${this.now().toISOString()} ${line}`);
    if (existing.length > 100) existing.splice(0, existing.length - 100);
    this.diagnostics.set(projectId, existing);
  }

  private emptyView(
    input: { projectId: string; threadId: string | null },
    capturedAt: string,
    detail: string,
  ): ObservatoryView {
    return {
      projectId: input.projectId,
      threadId: input.threadId,
      connected: false,
      capturedAt,
      ownership: {
        owner: 'none',
        runId: null,
        detail,
        since: null,
      },
      spend: {
        threadCost: { status: 'unknown', reason: detail },
        childrenKnownMicros: null,
        aggregate: { status: 'unknown', reason: detail },
        doubleCountAvoided: false,
        note: 'No native record can be read while the engine is unavailable.',
      },
      nodes: [],
      goals: [],
      tasks: [],
      fleetRuns: [],
      agentRuns: [],
      artifacts: [],
      caveats: [detail],
      diagnostics: [...(this.diagnostics.get(input.projectId) ?? [])],
    };
  }
}

function summarizeSpend(threadCost: CostEvidence, runs: ObservatoryView['agentRuns']): ObservatoryView['spend'] {
  const reported = runs.filter((run) => run.usage.status === 'reported' && run.usage.costMicros !== null);
  const childrenKnownMicros = reported.length
    ? reported.reduce((total, run) => total + (run.usage.costMicros ?? 0), 0)
    : null;
  const included = reported.filter((run) => run.spendIncludedInParent).length;
  let micros = threadCost.status === 'known' ? Math.round(threadCost.usd * 1_000_000) : null;
  let added = 0;
  if (micros !== null) {
    for (const run of reported) {
      if (!run.spendIncludedInParent) {
        added += run.usage.costMicros ?? 0;
      }
    }
    micros += added;
  }
  return {
    threadCost,
    childrenKnownMicros,
    aggregate:
      micros === null
        ? {
            status: 'unknown',
            reason: 'The parent thread cost is not known; child costs are shown separately and are not summed.',
          }
        : added === 0 && threadCost.status === 'known'
          ? threadCost
          : {
              status: 'known',
              usd: micros / 1_000_000,
              source: 'engine_priced',
              rateRevision: 'engine_thread_usage',
            },
    doubleCountAvoided: included > 0,
    note:
      included > 0
        ? `${included} child record(s) report spend already included in the parent thread total, so the aggregate uses the parent total once.`
        : 'No child spend was reported as part of the parent total; reported child costs are added once.',
  };
}

function buildNodes(
  threadId: string | null,
  goals: ObservatoryView['goals'],
  runs: ObservatoryView['agentRuns'],
  fleets: ObservatoryView['fleetRuns'],
  threadCost: CostEvidence,
): AgentNode[] {
  const rootId = threadId ? `thread:${threadId}` : 'thread:none';
  const nodes: AgentNode[] = [
    {
      id: rootId,
      parentId: null,
      kind: 'thread',
      label: threadId ? `Thread ${short(threadId)}` : 'No thread selected',
      role: null,
      status: threadId ? 'observed' : 'none',
      workspace: null,
      branch: null,
      taskId: null,
      turnId: null,
      lastEvent: null,
      tools: [],
      tests: [],
      spend: threadCost,
      spendIncludedInParent: false,
    },
  ];
  for (const goal of goals) {
    nodes.push({
      id: `goal:${goal.goalId}`,
      parentId: rootId,
      kind: 'goal',
      label: goal.objective || `Goal ${short(goal.goalId)}`,
      role: null,
      status: goal.status,
      workspace: null,
      branch: null,
      taskId: null,
      turnId: goal.threadId,
      lastEvent: `${goal.tokensUsed.toLocaleString()} tokens · ${goal.continuationCount} continuation(s)`,
      tools: [],
      tests: [],
      spend: {
        status: 'unknown',
        reason: 'The engine reports goal token counts, not a separate goal price.',
      },
      spendIncludedInParent: true,
    });
  }
  for (const run of runs) {
    nodes.push({
      id: `agent:${run.id}`,
      parentId: run.parentRunId ? `agent:${run.parentRunId}` : rootId,
      kind: 'agent',
      label: run.name,
      role: run.role,
      status: run.status,
      workspace: run.workspace || null,
      branch: null,
      taskId: null,
      turnId: run.originTurnId,
      lastEvent: run.events.at(-1)?.message ?? run.events.at(-1)?.status ?? null,
      tools: run.artifacts.filter((artifact) => artifact.kind === 'tool').map((artifact) => artifact.name),
      tests: run.artifacts.filter((artifact) => artifact.kind === 'test').map((artifact) => artifact.name),
      spend:
        run.usage.status === 'reported' && run.usage.costMicros !== null
          ? {
              status: 'known',
              usd: run.usage.costMicros / 1_000_000,
              source: 'engine_priced',
              rateRevision: 'engine_agent_usage',
            }
          : {
              status: 'unknown',
              reason: run.usage.note ?? 'The engine did not report this child’s price.',
            },
      spendIncludedInParent: run.spendIncludedInParent,
    });
  }
  for (const fleet of fleets) {
    const fleetId = `fleet:${fleet.id}`;
    nodes.push({
      id: fleetId,
      parentId: rootId,
      kind: 'fleet_run',
      label: `${fleet.name} · ${fleet.workflowKind}`,
      role: null,
      status: fleet.lifecycleStatus,
      workspace: null,
      branch: null,
      taskId: null,
      turnId: null,
      lastEvent: `${fleet.counts.queued} queued · ${fleet.counts.running} running · ${fleet.counts.completed} completed`,
      tools: [],
      tests: [],
      spend: {
        status: 'unknown',
        reason: 'This runtime does not report a fleet-run price on the run record.',
      },
      spendIncludedInParent: false,
    });
    for (const task of fleet.tasks) {
      nodes.push({
        id: `fleet-task:${fleet.id}:${task.taskId}`,
        parentId: fleetId,
        kind: 'fleet_task',
        label: `Task ${task.taskId}`,
        role: null,
        status: task.status,
        workspace: null,
        branch: null,
        taskId: task.taskId,
        turnId: null,
        lastEvent: task.leasedTo ? `Leased to ${task.leasedTo}` : `${task.attempts} attempt(s)`,
        tools: [],
        tests: [],
        spend: { status: 'unknown', reason: 'The run record carries no per-task price.' },
        spendIncludedInParent: false,
      });
    }
    for (const worker of fleet.workers) {
      nodes.push({
        id: `worker:${fleet.id}:${worker.id}`,
        parentId: fleetId,
        kind: 'worker',
        label: worker.name,
        role: null,
        status: 'declared',
        workspace: null,
        branch: null,
        taskId: null,
        turnId: null,
        lastEvent: `${worker.hostKind} · max ${worker.maxConcurrentTasks} task(s)`,
        tools: [],
        tests: [],
        spend: { status: 'unknown', reason: 'The run record carries no worker price.' },
        spendIncludedInParent: false,
      });
    }
  }
  return nodes;
}

function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}
