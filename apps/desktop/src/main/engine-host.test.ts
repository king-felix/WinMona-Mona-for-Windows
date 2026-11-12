import { describe, expect, it } from 'vitest';
import { WorkQueue, type RuntimeSupervisor, type ShutdownReceipt, type SupervisorEvent } from '@mona/adapter';
import { EngineHost } from './engine-host.js';
import { createAppInfo } from './ipc.js';

const receipt: ShutdownReceipt = {
  runtime_id: 'rt_0123456789abcdef01234567',
  requested_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:02.000Z',
  reason: 'app_quit',
  outcome: 'stopped',
  root_exited: true,
  observed_descendants: [99],
  remaining_pids: [],
  endpoint_closed: true,
  rollback_claimed: false,
};

function fakeSupervisor(workspace = 'x:\\work\\alpha'): {
  supervisor: RuntimeSupervisor;
  events: SupervisorEvent[];
  stopped: string[];
} {
  const events: SupervisorEvent[] = [];
  const stopped: string[] = [];
  const runtime = {
    runtimeId: 'rt_0123456789abcdef01234567',
    pid: 4242,
    workspace,
    endpoint: 'http://127.0.0.1:7903',
    identity: {} as never,
    report: { status: 'qualified' as const, reasons: [], capabilityGaps: [] } as never,
    record: {} as never,
    owned: true as const,
    token: 'secret-token-value',
    createAdapter: () => {
      throw new Error('not used in this test');
    },
    alive: async () => true,
  };
  const fake = {
    existing: () => runtime,
    status: () => ({
      state: 'running' as const,
      workspace: runtime.workspace,
      runtimeId: runtime.runtimeId,
      pid: runtime.pid,
      endpoint: runtime.endpoint,
      startedAt: '2026-01-01T00:00:00.000Z',
      restartCount: 0,
      lastFailure: null,
      reason: null,
    }),
    start: async () => ({ ok: true as const, value: runtime }),
    stop: async (reason: string) => {
      stopped.push(reason);
      return { ok: true as const, value: receipt };
    },
    reconcile: async () => ({
      ok: true as const,
      value: { inspected: 0, stale: [], reclaimed: [], unverifiable: [], invalid_records: [] },
    }),
    childPid: () => runtime.pid,
    hasExited: () => false,
    tokenDigest: () => null,
  };
  return { supervisor: fake as unknown as RuntimeSupervisor, events, stopped };
}

describe('EngineHost', () => {
  it('starts nothing until a project asks for a runtime', () => {
    const host = new EngineHost({ ownershipDir: 'C:\\data\\runtime', executable: 'codewhale.exe' });
    const summary = host.summary();
    expect(summary.state).toBe('not_started');
    expect(summary.pid).toBeNull();
    expect(summary.detail).toContain('only for a project you open');
  });

  it('reports a started runtime with its compatibility status', async () => {
    const { supervisor } = fakeSupervisor();
    const host = new EngineHost({
      ownershipDir: 'C:\\data\\runtime',
      executable: 'codewhale.exe',
      supervisorFactory: () => supervisor,
    });
    const started = await host.startProjectRuntime({ workspace: 'C:\\work\\alpha' });
    expect(started.ok).toBe(true);
    const summary = host.summary();
    expect(summary.state).toBe('connected');
    expect(summary.compatibility).toBe('qualified');
    expect(summary.pid).toBe(4242);
    expect(summary.endpoint).toBe('http://127.0.0.1:7903');
  });

  it('quit and stop reports the real receipt and never claims rollback', async () => {
    const { supervisor, stopped } = fakeSupervisor();
    const host = new EngineHost({
      ownershipDir: 'C:\\data\\runtime',
      executable: 'codewhale.exe',
      supervisorFactory: () => supervisor,
    });
    await host.startProjectRuntime({ workspace: 'C:\\work\\alpha' });
    await host.quitAndStopWork();
    expect(stopped).toEqual(['app_quit']);
    expect(host.shutdownReceipt()?.outcome).toBe('stopped');
    expect(host.shutdownReceipt()?.rollback_claimed).toBe(false);
  });

  it('a renderer crash keeps the runtime and asks for a new window', async () => {
    const { supervisor, stopped } = fakeSupervisor();
    const host = new EngineHost({
      ownershipDir: 'C:\\data\\runtime',
      executable: 'codewhale.exe',
      supervisorFactory: () => supervisor,
    });
    await host.startProjectRuntime({ workspace: 'C:\\work\\alpha' });
    const actions = host.handleSignal('renderer-process-gone');
    expect(actions.map((action) => action.type)).toEqual(['keep-runtime', 'recreate-window']);
    expect(stopped).toEqual([]);
    expect(host.summary().state).toBe('connected');
  });

  it('a runtime crash is labeled and marked outcome unknown without resubmission', async () => {
    const host = new EngineHost({
      ownershipDir: 'C:\\data\\runtime',
      executable: 'codewhale.exe',
      supervisorFactory: () => fakeSupervisor().supervisor,
    });
    await host.startProjectRuntime({ workspace: 'C:\\work\\alpha' });
    const idle = host.handleSignal('runtime-exited-unexpected');
    expect(idle).toContainEqual({ type: 'mark-runtime-crashed', restart: 'bounded' });
    // No active work means no unknown outcome to declare.
    expect(idle).not.toContainEqual({ type: 'mark-outcome-unknown', reason: 'runtime_crashed' });
    expect(host.summary().state).toBe('crashed');
    expect(host.summary().detail).toContain('no work is resubmitted');
  });

  it('a runtime crash during active work declares the outcome unknown', async () => {
    const host = new EngineHost({
      ownershipDir: 'C:\\data\\runtime',
      executable: 'codewhale.exe',
      supervisorFactory: () => fakeSupervisor().supervisor,
    });
    await host.startProjectRuntime({ workspace: 'C:\\work\\alpha' });
    const queue = new WorkQueue();
    queue.enqueue({ taskId: 'tsk_1', label: 'work' });
    queue.startNext();
    queue.markActive({
      taskId: 'tsk_1',
      label: 'work',
      threadId: `thr_${'1'.repeat(32)}` as never,
      turnId: `turn_${'2'.repeat(32)}` as never,
    });
    host.bindQueue(queue);
    const actions = host.handleSignal('runtime-exited-unexpected');
    expect(actions).toContainEqual({ type: 'mark-outcome-unknown', reason: 'runtime_crashed' });
    expect(host.summary().detail).toContain('Outcome unknown');
  });

  it('refuses a second workspace while one runtime is owned, and is idempotent for the same one', async () => {
    const host = new EngineHost({
      ownershipDir: 'C:\\data\\runtime',
      executable: 'codewhale.exe',
      supervisorFactory: () => fakeSupervisor('C:\\work\\alpha').supervisor,
    });
    await host.startProjectRuntime({ workspace: 'C:\\work\\alpha' });
    const same = await host.startProjectRuntime({ workspace: 'C:\\work\\alpha' });
    expect(same.ok).toBe(true);
    const second = await host.startProjectRuntime({ workspace: 'C:\\work\\beta' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toContain('already owns a runtime');
    const attached = await host.attachUserRuntime({ baseUrl: 'http://127.0.0.1:7904', token: '[redacted]' });
    expect(attached.ok).toBe(false);
    if (!attached.ok) expect(attached.error.code).toBe('invalid_request');
  });

  it('reports an external runtime as read-only and never stops it', async () => {
    const host = new EngineHost({
      ownershipDir: 'C:\\data\\runtime',
      executable: 'codewhale.exe',
      attachExternal: async () => ({
        ok: true,
        value: {
          baseUrl: 'http://127.0.0.1:7905',
          identity: { workspace: 'C:\\work\\gamma' } as never,
          report: { status: 'compatible_unqualified', reasons: ['drift'], capabilityGaps: [] } as never,
          owned: false,
          createAdapter: () => {
            throw new Error('not used');
          },
          stop: async () => ({
            ok: false,
            error: { code: 'invalid_request', message: 'not owned', retryable: false },
          }),
        },
      }),
    });
    const attached = await host.attachUserRuntime({ baseUrl: 'http://127.0.0.1:7905', token: '[redacted]' });
    expect(attached.ok).toBe(true);
    expect(host.summary().compatibility).toBe('compatible_unqualified');
    expect(host.summary().descriptors.join(' ')).toContain('read-only attach');
    const stopped = await host.stopOwned('app_quit');
    expect(stopped.ok).toBe(true);
  });

  it('quit while the queue has active work interrupts first, then stops', async () => {
    const { supervisor, stopped } = fakeSupervisor();
    const host = new EngineHost({
      ownershipDir: 'C:\\data\\runtime',
      executable: 'codewhale.exe',
      supervisorFactory: () => supervisor,
    });
    await host.startProjectRuntime({ workspace: 'C:\\work\\alpha' });
    const queue = new WorkQueue();
    queue.enqueue({ taskId: 'tsk_1', label: 'work' });
    queue.startNext();
    queue.markActive({
      taskId: 'tsk_1',
      label: 'work',
      threadId: `thr_${'1'.repeat(32)}` as never,
      turnId: `turn_${'2'.repeat(32)}` as never,
    });
    host.bindQueue(queue);
    await host.quitAndStopWork();
    expect(stopped).toEqual(['app_quit']);
    expect(queue.snapshot().state).toBe('stopped');
    expect(queue.snapshot().active).toBeNull();
  });
});

describe('app info engine state', () => {
  it('defaults to an honest not-started label with no descriptors', () => {
    const info = createAppInfo({
      version: '0.1.0',
      electron: '45.3.0',
      chrome: '156.0.0',
      node: '24.0.0',
      platform: 'win32',
      arch: 'x64',
    });
    expect(info.engine.status).toBe('not_started');
    expect(info.engine.descriptors).toEqual([]);
    expect(JSON.stringify(info)).not.toContain('token');
  });

  it('carries the observed engine state and redacted descriptors', () => {
    const info = createAppInfo({
      version: '0.1.0',
      electron: '45.3.0',
      chrome: '156.0.0',
      node: '24.0.0',
      platform: 'win32',
      arch: 'x64',
      engine: {
        status: 'crashed',
        detail: 'Runtime exited unexpectedly (code 7).',
        descriptors: ['quit receipt: stopped'],
      },
    });
    expect(info.engine.status).toBe('crashed');
    expect(info.engine.descriptors).toEqual(['quit receipt: stopped']);
  });
});
