import { errorResult } from '@mona/contracts';
import { z } from 'zod';
import { AGENT_CHANNELS } from '../shared/agents.js';
import type { IpcResult } from '../shared/catalog.js';
import type { AgentObservatoryService } from './agent-observatory.js';
import type { IpcHandle } from './ipc.js';

const ViewRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    threadId: z.string().min(1).max(200).nullable(),
  })
  .strict();
const RunRequest = z.object({ projectId: z.string().min(1).max(80), runId: z.string().min(1).max(300) }).strict();
const WorkerRequest = z.object({ projectId: z.string().min(1).max(80), workerId: z.string().min(1).max(300) }).strict();
const TaskRequest = z.object({ projectId: z.string().min(1).max(80), taskId: z.string().min(1).max(300) }).strict();
const CreateRunRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    name: z.string().min(1).max(80),
    instructions: z.string().min(1).max(20_000),
    role: z.string().min(1).max(80),
  })
  .strict();
const GoalCreateRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    threadId: z.string().min(1).max(200),
    objective: z.string().min(1).max(4_000),
  })
  .strict();
const GoalCompleteRequest = z
  .object({ projectId: z.string().min(1).max(80), threadId: z.string().min(1).max(200) })
  .strict();

type Handler = (payload: unknown, service: AgentObservatoryService) => IpcResult<unknown> | Promise<IpcResult<unknown>>;

export function registerAgentIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  service: () => AgentObservatoryService | null;
}): string[] {
  const channels: string[] = [];
  const register = (channel: string, schema: z.ZodType, handler: Handler): void => {
    channels.push(channel);
    deps.handle(channel, (event, payload) => {
      if (!deps.isTrustedSender(event)) {
        return { ok: false, error: errorResult('untrusted_sender', 'IPC sender is not the Mona application frame.') };
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        return { ok: false, error: errorResult('invalid_request', `${channel} received an invalid request.`) };
      }
      const service = deps.service();
      if (!service) {
        return {
          ok: false,
          error: errorResult('internal', 'Native orchestration is only available inside the running app.', true),
        };
      }
      try {
        return handler(parsed.data, service);
      } catch {
        return { ok: false, error: errorResult('internal', 'The native orchestration action failed.', true) };
      }
    });
  };

  register(AGENT_CHANNELS.get, ViewRequest, (payload, service) => {
    const input = payload as { projectId: string; threadId: string | null };
    return service.view(input);
  });
  register(AGENT_CHANNELS.createFleetRun, CreateRunRequest, (payload, service) =>
    service.createFleetRun(payload as { projectId: string; name: string; instructions: string; role: string }),
  );
  register(AGENT_CHANNELS.startFleetRun, RunRequest, (payload, service) =>
    service.startFleetRun(payload as { projectId: string; runId: string }),
  );
  register(AGENT_CHANNELS.stopFleetRun, RunRequest, (payload, service) =>
    service.stopFleetRun(payload as { projectId: string; runId: string }),
  );
  register(AGENT_CHANNELS.interruptWorker, WorkerRequest, (payload, service) =>
    service.interruptWorker(payload as { projectId: string; workerId: string }),
  );
  register(AGENT_CHANNELS.cancelAgentRun, RunRequest, (payload, service) =>
    service.cancelAgentRun(payload as { projectId: string; runId: string }),
  );
  register(AGENT_CHANNELS.cancelTask, TaskRequest, (payload, service) =>
    service.cancelTask(payload as { projectId: string; taskId: string }),
  );
  register(AGENT_CHANNELS.createGoal, GoalCreateRequest, (payload, service) =>
    service.createGoal(payload as { projectId: string; threadId: string; objective: string }),
  );
  register(AGENT_CHANNELS.completeGoal, GoalCompleteRequest, (payload, service) =>
    service.completeGoal(payload as { projectId: string; threadId: string }),
  );
  return channels;
}
