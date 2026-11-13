import { describe, expect, it } from 'vitest';
import type { TaskService } from '@mona/project-state';
import { TASK_CHANNELS } from '../shared/tasks.js';
import type { IpcHandle } from './ipc.js';
import { registerTaskIpc } from './tasks-ipc.js';

/**
 * Work board IPC: the board is read from the task service, creation records a
 * pending task, and eligibility is copied from the service rather than
 * recomputed in the view (a second scheduler is exactly what must not exist).
 */
const task = (overrides: Record<string, unknown> = {}) => ({
  id: 'tsk_1',
  projectId: 'prj_1',
  title: 'First task',
  status: 'pending',
  promptId: null,
  description: '',
  executionOwner: 'mona_queue',
  promptText: '',
  ordinal: 1,
  currentStep: null,
  claimedAt: null,
  startedAt: null,
  completedAt: null,
  blockedReason: null,
  skippedReason: null,
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
  steps: [],
  criteria: [],
  requirements: [],
  dependencies: [],
  dependents: [],
  evidence: [],
  transitions: [],
  ...overrides,
});

function harness(options: { trusted?: boolean; service?: boolean } = {}) {
  const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const handle: IpcHandle = (channel, listener) => {
    listeners.set(channel, listener as (event: unknown, payload: unknown) => unknown);
  };
  const created: Array<Record<string, unknown>> = [];
  let boardState = {
    projectId: 'prj_1',
    generatedAt: '2026-11-12T00:00:00.000Z',
    tasks: [
      {
        task: task({ id: 'tsk_2', title: 'Second', ordinal: 2, status: 'blocked', dependencies: ['tsk_1'] }),
        eligibility: {
          taskId: 'tsk_2',
          eligible: false,
          reason: 'waits on tsk_1',
          checks: [],
          blockedByProblemIds: [],
        },
      },
      {
        task: task({ id: 'tsk_1', title: 'First', ordinal: 1 }),
        eligibility: { taskId: 'tsk_1', eligible: true, reason: 'ready', checks: [], blockedByProblemIds: [] },
      },
    ],
    eligible: ['tsk_1'],
    next: 'tsk_1',
  };

  const service = {
    board: async () => boardState,
    createTask: async (input: Record<string, unknown>) => {
      created.push(input);
      if (input.title === 'cyclic') {
        throw Object.assign(new Error('dependency cycle'), { name: 'StateError', code: 'dependency_cycle' });
      }
      boardState = {
        ...boardState,
        tasks: [
          ...boardState.tasks,
          {
            task: task({ id: 'tsk_3', title: String(input.title), ordinal: 3 }),
            eligibility: { taskId: 'tsk_3', eligible: true, reason: 'ready', checks: [], blockedByProblemIds: [] },
          },
        ],
      };
      return boardState.tasks[boardState.tasks.length - 1]?.task;
    },
  } as unknown as TaskService;

  const channels = registerTaskIpc({
    handle,
    isTrustedSender: () => options.trusted ?? true,
    service: () => (options.service === false ? null : service),
  });
  const invoke = async (channel: string, payload: unknown): Promise<unknown> => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`channel ${channel} not registered`);
    return await listener({}, payload);
  };
  return { channels, invoke, created };
}

describe('task IPC surface', () => {
  it('registers exactly the declared channels', () => {
    const { channels } = harness();
    expect([...channels].sort()).toEqual(Object.values(TASK_CHANNELS).sort());
  });

  it('refuses an untrusted sender', async () => {
    const { invoke } = harness({ trusted: false });
    const result = (await invoke(TASK_CHANNELS.board, { projectId: 'prj_1' })) as { ok: boolean };
    expect(result.ok).toBe(false);
  });

  it('orders the board by ordinal and keeps the service eligibility verdict', async () => {
    const { invoke } = harness();
    const result = (await invoke(TASK_CHANNELS.board, { projectId: 'prj_1' })) as {
      ok: true;
      data: {
        tasks: Array<{ id: string; eligible: boolean; eligibilityReason: string; dependencies: string[] }>;
        next: string;
        counts: Record<string, number>;
      };
    };
    expect(result.ok).toBe(true);
    expect(result.data.tasks.map((entry) => entry.id)).toEqual(['tsk_1', 'tsk_2']);
    expect(result.data.tasks[1]).toMatchObject({
      eligible: false,
      eligibilityReason: 'waits on tsk_1',
      dependencies: ['tsk_1'],
    });
    expect(result.data.next).toBe('tsk_1');
    expect(result.data.counts.pending).toBe(1);
    expect(result.data.counts.blocked).toBe(1);
  });

  it('records a new task with its steps and criteria, and starts nothing', async () => {
    const { invoke, created } = harness();
    const result = (await invoke(TASK_CHANNELS.create, {
      projectId: 'prj_1',
      title: 'New work',
      owner: 'mona_queue',
      steps: ['one', 'two'],
      criteria: ['it works'],
    })) as { ok: true; data: { tasks: Array<{ title: string }> } };
    expect(result.ok).toBe(true);
    expect(created[0]).toMatchObject({
      title: 'New work',
      owner: 'mona_queue',
      steps: [{ title: 'one' }, { title: 'two' }],
      criteria: [{ description: 'it works' }],
    });
    expect(result.data.tasks.some((entry) => entry.title === 'New work')).toBe(true);
  });

  it('rejects a blank title and an unknown owner before the service is called', async () => {
    const { invoke, created } = harness();
    const blank = (await invoke(TASK_CHANNELS.create, { projectId: 'prj_1', title: '  ', owner: 'mona_queue' })) as {
      ok: boolean;
    };
    const owner = (await invoke(TASK_CHANNELS.create, { projectId: 'prj_1', title: 'x', owner: 'robot' })) as {
      ok: boolean;
    };
    expect(blank.ok).toBe(false);
    expect(owner.ok).toBe(false);
    expect(created).toEqual([]);
  });

  it('surfaces a dependency cycle from the service as a conflict', async () => {
    const { invoke } = harness();
    const result = (await invoke(TASK_CHANNELS.create, {
      projectId: 'prj_1',
      title: 'cyclic',
      owner: 'mona_queue',
    })) as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('conflict');
    expect(result.error.message).toContain('cycle');
  });

  it('reports unavailable local state honestly', async () => {
    const { invoke } = harness({ service: false });
    const result = (await invoke(TASK_CHANNELS.board, { projectId: 'prj_1' })) as {
      ok: false;
      error: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('internal');
  });
});
