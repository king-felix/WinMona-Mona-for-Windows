import { describe, expect, it } from 'vitest';
import { registerAgentIpc } from './agents-ipc.js';
import type { IpcHandle } from './ipc.js';
import type { AgentObservatoryService } from './agent-observatory.js';
import { AGENT_CHANNELS } from '../shared/agents.js';

function harness(options: { trusted?: boolean; service?: boolean } = {}) {
  const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const handle: IpcHandle = (channel, listener) => {
    listeners.set(channel, listener as (event: unknown, payload: unknown) => unknown);
  };
  const calls: string[] = [];
  const service = {
    view: async (input: { projectId: string; threadId: string | null }) => {
      calls.push(`view:${input.projectId}:${input.threadId ?? 'none'}`);
      return { ok: true as const, data: { projectId: input.projectId } };
    },
    createFleetRun: async (input: { projectId: string; name: string }) => {
      calls.push(`create:${input.projectId}:${input.name}`);
      return { ok: true as const, data: { runId: 'fleet-1', detail: 'queued' } };
    },
    startFleetRun: async (input: { projectId: string; runId: string }) => {
      calls.push(`start:${input.runId}`);
      return {
        ok: true as const,
        data: {
          receipt: {
            action: 'start',
            execution: 'scheduled',
            runId: input.runId,
            target: 'this_computer',
            leased: 0,
            queued: 1,
            workerIds: [],
          },
          observation: { leased: 0, runningTasks: 0, detail: 'no lease' },
        },
      };
    },
    stopFleetRun: async (input: { runId: string }) => {
      calls.push(`stop:${input.runId}`);
      return { ok: true as const, data: { acknowledged: true } };
    },
    interruptWorker: async (input: { workerId: string }) => {
      calls.push(`worker:${input.workerId}`);
      return { ok: true as const, data: { acknowledged: true } };
    },
    cancelAgentRun: async (input: { runId: string }) => {
      calls.push(`cancel-agent:${input.runId}`);
      return { ok: true as const, data: { acknowledged: true } };
    },
    cancelTask: async (input: { taskId: string }) => {
      calls.push(`cancel-task:${input.taskId}`);
      return { ok: true as const, data: { acknowledged: true } };
    },
    createGoal: async (input: { projectId: string; threadId: string }) => {
      calls.push(`goal:${input.projectId}:${input.threadId}`);
      return { ok: true as const, data: { goalId: 'goal-1', detail: 'started' } };
    },
    completeGoal: async (input: { projectId: string; threadId: string }) => {
      calls.push(`complete-goal:${input.threadId}`);
      return { ok: true as const, data: { acknowledged: true } };
    },
  } as unknown as AgentObservatoryService;

  const channels = registerAgentIpc({
    handle,
    isTrustedSender: () => options.trusted ?? true,
    service: () => (options.service === false ? null : service),
  });

  const invoke = (channel: string, payload: unknown): unknown => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`channel ${channel} not registered`);
    return listener({}, payload);
  };
  return { channels, invoke, calls };
}

describe('agent IPC surface', () => {
  it('registers exactly the declared channels', () => {
    const { channels } = harness();
    expect(channels.sort()).toEqual(Object.values(AGENT_CHANNELS).sort());
  });

  it('validates every payload before it reaches the service', async () => {
    const { invoke, calls } = harness();
    const bad = await invoke(AGENT_CHANNELS.createFleetRun, { projectId: 'prj_1' });
    expect(bad).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
    const good = await invoke(AGENT_CHANNELS.get, { projectId: 'prj_1', threadId: null });
    expect(good).toMatchObject({ ok: true });
    expect(calls).toEqual(['view:prj_1:none']);
  });

  it('refuses an untrusted sender before validation', async () => {
    const { invoke } = harness({ trusted: false });
    const result = await invoke(AGENT_CHANNELS.get, { projectId: 'prj_1', threadId: null });
    expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
  });

  it('reports that the service is unavailable without pretending success', async () => {
    const { invoke } = harness({ service: false });
    const result = await invoke(AGENT_CHANNELS.get, { projectId: 'prj_1', threadId: null });
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('passes an explicit start through and keeps the receipt', async () => {
    const { invoke } = harness();
    const result = (await invoke(AGENT_CHANNELS.startFleetRun, { projectId: 'prj_1', runId: 'fleet-1' })) as {
      ok: boolean;
      data: { receipt: { execution: string }; observation: { detail: string } };
    };
    expect(result.ok).toBe(true);
    expect(result.data.receipt.execution).toBe('scheduled');
    expect(result.data.observation.detail).toBe('no lease');
  });
});
