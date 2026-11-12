import type { ObservatoryView } from '@mona/contracts';
import type { IpcResult } from './catalog.js';

/**
 * Renderer-facing observatory vocabulary. The renderer receives Mona's
 * projection (already mapped from engine records) and never a raw runtime body.
 */
export const AGENT_CHANNELS = {
  get: 'mona:agents-get',
  createFleetRun: 'mona:agents-create-fleet-run',
  startFleetRun: 'mona:agents-start-fleet-run',
  stopFleetRun: 'mona:agents-stop-fleet-run',
  interruptWorker: 'mona:agents-interrupt-worker',
  cancelAgentRun: 'mona:agents-cancel-agent-run',
  cancelTask: 'mona:agents-cancel-task',
  createGoal: 'mona:agents-create-goal',
  completeGoal: 'mona:agents-complete-goal',
} as const;

export type ObservatoryRequest = {
  projectId: string;
  threadId: string | null;
};

export type FleetRunCreateResult = { runId: string; detail: string };

export type FleetStartResult = {
  receipt: {
    action: string;
    execution: string;
    runId: string;
    target: string;
    leased: number;
    queued: number;
    workerIds: string[];
  };
  observation: { leased: number; runningTasks: number; detail: string };
};

export type ControlAck = { acknowledged: boolean };
export type GoalCreateResult = { goalId: string; detail: string };

export type AgentBridge = {
  observatoryGet(input: ObservatoryRequest): Promise<IpcResult<ObservatoryView>>;
  createFleetRun(input: {
    projectId: string;
    name: string;
    instructions: string;
    role: string;
  }): Promise<IpcResult<FleetRunCreateResult>>;
  startFleetRun(input: { projectId: string; runId: string }): Promise<IpcResult<FleetStartResult>>;
  stopFleetRun(input: { projectId: string; runId: string }): Promise<IpcResult<ControlAck>>;
  interruptWorker(input: { projectId: string; workerId: string }): Promise<IpcResult<ControlAck>>;
  cancelAgentRun(input: { projectId: string; runId: string }): Promise<IpcResult<ControlAck>>;
  cancelTask(input: { projectId: string; taskId: string }): Promise<IpcResult<ControlAck>>;
  createGoal(input: { projectId: string; threadId: string; objective: string }): Promise<IpcResult<GoalCreateResult>>;
  completeGoal(input: { projectId: string; threadId: string }): Promise<IpcResult<ControlAck>>;
};
