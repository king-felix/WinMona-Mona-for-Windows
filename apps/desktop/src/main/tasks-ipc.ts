import { errorResult } from '@mona/contracts';
import type { TaskService } from '@mona/project-state';
import { z } from 'zod';
import type { IpcResult } from '../shared/catalog.js';
import { TASK_CHANNELS, type TaskBoardView } from '../shared/tasks.js';
import type { IpcHandle } from './ipc.js';
import { toTaskBoardView } from './tasks-view.js';

const ProjectRequest = z.object({ projectId: z.string().min(1).max(80) }).strict();
const ShortText = z.string().trim().min(1).max(200);
const CreateRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    title: ShortText,
    description: z.string().max(2_000).optional(),
    promptText: z.string().max(20_000).optional(),
    owner: z.enum(['mona_queue', 'native_workflow']),
    steps: z.array(ShortText).max(50).optional(),
    criteria: z.array(ShortText).max(50).optional(),
    dependsOn: z.array(z.string().min(1).max(80)).max(50).optional(),
  })
  .strict();

function describe(error: unknown): {
  code: 'invalid_request' | 'not_found' | 'conflict' | 'internal';
  message: string;
} {
  const candidate = error as { name?: string; code?: string; message?: string } | null;
  if (candidate?.name === 'StateError' && typeof candidate.message === 'string') {
    const code =
      candidate.code === 'not_found'
        ? 'not_found'
        : candidate.code === 'conflict' || candidate.code === 'dependency_cycle' || candidate.code === 'not_eligible'
          ? 'conflict'
          : candidate.code === 'internal'
            ? 'internal'
            : 'invalid_request';
    return { code, message: candidate.message.slice(0, 500) };
  }
  return { code: 'internal', message: 'The task request failed.' };
}

/**
 * The work board: read the service's board, and create a pending task.
 *
 * Creating a task starts nothing. Execution stays in Studio, and eligibility,
 * dependencies and evidence are the task service's own facts. This module adds no
 * scheduler, no timer and no background work.
 */
export function registerTaskIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  service: () => TaskService | null;
}): string[] {
  const channels: string[] = [];
  const guard = (event: unknown): IpcResult<never> | null =>
    deps.isTrustedSender(event)
      ? null
      : { ok: false, error: errorResult('untrusted_sender', 'IPC sender is not the Mona application frame.') };

  const unavailable = (): IpcResult<never> => ({
    ok: false,
    error: errorResult('internal', 'Local project state is unavailable. See Diagnostics.', true),
  });

  deps.handle(TASK_CHANNELS.board, async (event, payload) => {
    const denied = guard(event);
    if (denied) return denied;
    const parsed = ProjectRequest.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: errorResult('invalid_request', 'task-board received an invalid request.') };
    }
    const service = deps.service();
    if (!service) return unavailable();
    try {
      const board = await service.board(parsed.data.projectId);
      return { ok: true, data: toTaskBoardView(board) };
    } catch (error) {
      const problem = describe(error);
      return { ok: false, error: errorResult(problem.code, problem.message) };
    }
  });
  channels.push(TASK_CHANNELS.board);

  deps.handle(TASK_CHANNELS.create, async (event, payload) => {
    const denied = guard(event);
    if (denied) return denied;
    const parsed = CreateRequest.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: errorResult('invalid_request', 'task-create received an invalid request.') };
    }
    const service = deps.service();
    if (!service) return unavailable();
    const input = parsed.data;
    try {
      await service.createTask({
        projectId: input.projectId,
        title: input.title,
        owner: input.owner,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.promptText === undefined ? {} : { promptText: input.promptText }),
        ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
        ...(input.steps === undefined ? {} : { steps: input.steps.map((title) => ({ title })) }),
        ...(input.criteria === undefined ? {} : { criteria: input.criteria.map((description) => ({ description })) }),
      });
      const board = await service.board(input.projectId);
      return { ok: true, data: toTaskBoardView(board) satisfies TaskBoardView };
    } catch (error) {
      const problem = describe(error);
      return { ok: false, error: errorResult(problem.code, problem.message) };
    }
  });
  channels.push(TASK_CHANNELS.create);

  return channels;
}
