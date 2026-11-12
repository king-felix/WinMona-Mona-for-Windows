import { describe, expect, it } from 'vitest';
import { ThreadId, TurnId } from '@mona/contracts';
import { WorkQueue, type ActiveWork } from './work-control.js';
import { decideLifecycle, parseLaunchArgs, type LifecycleContext } from './lifecycle.js';
import { ok, fail } from './errors.js';

const threadId = ThreadId.parse(`thr_${'1'.repeat(32)}`);
const turnId = TurnId.parse(`turn_${'2'.repeat(32)}`);

function active(): ActiveWork {
  return {
    taskId: 'tsk_1',
    label: 'Build the thing',
    threadId,
    turnId,
    startedAt: '2026-01-01T00:00:00.000Z',
  };
}

const baseContext: LifecycleContext = {
  hasActiveWork: true,
  queuedWork: 2,
  runtimeOwned: true,
  runtimeAlive: true,
  closeToTray: true,
  quitInProgress: false,
  staleOwnershipRecords: 0,
};

describe('WorkQueue transitions', () => {
  it('pauses after the current task without interrupting it', () => {
    const queue = new WorkQueue();
    queue.enqueue({ taskId: 'tsk_1', label: 'first' });
    queue.enqueue({ taskId: 'tsk_2', label: 'second' });
    expect(queue.startNext()?.taskId).toBe('tsk_1');
    queue.markActive(active());
    const receipt = queue.pauseAfterTask();
    expect(receipt.outcome).toBe('applied');
    expect(receipt.rollback_claimed).toBe(false);
    expect(queue.snapshot().active?.taskId).toBe('tsk_1');
    queue.completeActive('completed');
    expect(queue.snapshot().state).toBe('paused');
    expect(queue.startNext()).toBeNull();
    expect(queue.snapshot().queued.map((task) => task.taskId)).toEqual(['tsk_2']);
  });

  it('cancels queued work only, never the running task', () => {
    const queue = new WorkQueue();
    queue.enqueue({ taskId: 'tsk_1', label: 'first' });
    queue.enqueue({ taskId: 'tsk_2', label: 'second' });
    queue.startNext();
    queue.markActive(active());
    const running = queue.cancelQueued('tsk_1');
    expect(running.outcome).toBe('rejected');
    const queued = queue.cancelQueued('tsk_2');
    expect(queued.outcome).toBe('applied');
    expect(queue.snapshot().active?.taskId).toBe('tsk_1');
    expect(queue.snapshot().queued).toEqual([]);
  });

  it('reports an interrupt with no channel as outcome unknown', async () => {
    const queue = new WorkQueue();
    queue.enqueue({ taskId: 'tsk_1', label: 'first' });
    queue.startNext();
    queue.markActive(active());
    const receipt = await queue.interruptNow(null);
    expect(receipt.outcome).toBe('outcome_unknown');
    expect(receipt.rollback_claimed).toBe(false);
    expect(queue.snapshot().active).not.toBeNull();
  });

  it('labels a failed interrupt as uncertain and keeps active work', async () => {
    const queue = new WorkQueue();
    queue.enqueue({ taskId: 'tsk_1', label: 'first' });
    queue.startNext();
    queue.markActive(active());
    const receipt = await queue.interruptNow(async () => fail('transport_failed', 'connection dropped'));
    expect(receipt.outcome).toBe('outcome_unknown');
    expect(queue.snapshot().active).not.toBeNull();
  });

  it('quit-and-stop interrupts then stops and reports a partial receipt truthfully', async () => {
    const queue = new WorkQueue();
    queue.enqueue({ taskId: 'tsk_1', label: 'first' });
    queue.startNext();
    queue.markActive(active());
    const receipt = await queue.quitAndStop({
      interrupt: async () => ok({ threadId, turnId, acknowledgedStatus: 'interrupted' }),
      stopRuntime: async () =>
        ok({
          runtime_id: 'rt_0123456789abcdef01234567',
          requested_at: '2026-01-01T00:00:00.000Z',
          completed_at: '2026-01-01T00:00:01.000Z',
          reason: 'quit',
          outcome: 'stopped_forced',
          root_exited: true,
          observed_descendants: [77],
          remaining_pids: [],
          endpoint_closed: true,
          rollback_claimed: false,
        }),
    });
    expect(receipt.outcome).toBe('applied');
    expect(receipt.interrupt.outcome).toBe('applied');
    expect(receipt.stop?.outcome).toBe('stopped_forced');
    expect(receipt.rollback_claimed).toBe(false);
    expect(queue.snapshot().state).toBe('stopped');
  });

  it('quit-and-stop is partial when the stop is uncertain', async () => {
    const queue = new WorkQueue();
    queue.enqueue({ taskId: 'tsk_1', label: 'first' });
    queue.startNext();
    queue.markActive(active());
    const receipt = await queue.quitAndStop({
      interrupt: async () => ok({ threadId, turnId, acknowledgedStatus: 'interrupting' }),
      stopRuntime: async () => fail('outcome_unknown', 'process did not exit'),
    });
    expect(receipt.outcome).toBe('partial');
    expect(receipt.stop?.outcome).toBe('uncertain');
  });
});

describe('desktop lifecycle matrix', () => {
  it('keeps the runtime and recreates the window after a renderer crash', () => {
    const actions = decideLifecycle('renderer-process-gone', baseContext);
    expect(actions.map((action) => action.type)).toEqual(['keep-runtime', 'recreate-window']);
  });

  it('keeps owned work alive when the window closes', () => {
    const actions = decideLifecycle('window-closed', baseContext);
    expect(actions.map((action) => action.type)).toEqual(['keep-runtime', 'hide-to-tray']);
  });

  it('interrupts and stops owned work on quit', () => {
    const actions = decideLifecycle('app-before-quit', baseContext);
    expect(actions.map((action) => action.type)).toEqual(['interrupt-active-turn', 'stop-owned-runtime']);
  });

  it('does not claim ownership of an external runtime on quit', () => {
    const actions = decideLifecycle('app-before-quit', { ...baseContext, runtimeOwned: false });
    expect(actions).toEqual([{ type: 'none' }]);
  });

  it('marks a crashed runtime and bounds process restart without resubmitting', () => {
    const actions = decideLifecycle('runtime-exited-unexpected', baseContext);
    expect(actions).toContainEqual({ type: 'mark-runtime-crashed', restart: 'bounded' });
    expect(actions).toContainEqual({ type: 'mark-outcome-unknown', reason: 'runtime_crashed' });
  });

  it('reconciles stale ownership after a machine restart', () => {
    const actions = decideLifecycle('machine-restart-detected', {
      ...baseContext,
      runtimeAlive: false,
      staleOwnershipRecords: 2,
    });
    expect(actions).toEqual([{ type: 'reconcile-stale-ownership', count: 2 }]);
  });

  it('routes a second launcher invocation to the existing owner', () => {
    const actions = decideLifecycle('second-instance', baseContext);
    expect(actions.map((action) => action.type)).toEqual(['focus-existing-window', 'queue-launch-path']);
  });
});

describe('launch argument parsing', () => {
  it('extracts only real absolute paths and ignores Electron switches', () => {
    const paths = parseLaunchArgs(
      ['electron.exe', '.', '--smoke-test', 'C:\\Work\\Alpha', 'C:\\Work\\Alpha', '--user-data-dir=C:\\x'],
      'C:\\Work',
      'win32',
    );
    expect(paths).toEqual(['c:\\work', 'c:\\work\\alpha']);
  });
});
