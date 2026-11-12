/**
 * Desktop lifecycle decisions, kept separate from Electron so the matrix can
 * be tested. Each signal has one deliberate consequence; no signal silently
 * becomes "quit" or "restart the task".
 */
import { parseLaunchCommand } from './cli.js';

export type LifecycleSignal =
  | 'renderer-process-gone'
  | 'window-closed'
  | 'app-before-quit'
  | 'app-will-quit'
  | 'runtime-exited-expected'
  | 'runtime-exited-unexpected'
  | 'forced-termination-detected'
  | 'machine-restart-detected'
  | 'second-instance';

export type LifecycleContext = {
  hasActiveWork: boolean;
  queuedWork: number;
  runtimeOwned: boolean;
  runtimeAlive: boolean;
  closeToTray: boolean;
  quitInProgress: boolean;
  staleOwnershipRecords: number;
};

export type LifecycleAction =
  | { type: 'recreate-window'; reason: 'renderer_crashed' }
  | { type: 'keep-runtime'; reason: 'window_closed' | 'renderer_crashed' }
  | { type: 'hide-to-tray'; reason: 'window_closed' }
  | { type: 'interrupt-active-turn'; reason: 'quit_and_stop' }
  | { type: 'stop-owned-runtime'; reason: 'quit_and_stop' | 'forced_termination' | 'startup_recovery' }
  | {
      type: 'mark-outcome-unknown';
      reason: 'forced_termination' | 'quit_interrupt_uncertain' | 'runtime_crashed';
    }
  | { type: 'mark-runtime-crashed'; restart: 'bounded' | 'none' }
  | { type: 'reconcile-stale-ownership'; count: number }
  | { type: 'queue-launch-path' }
  | { type: 'focus-existing-window' }
  | { type: 'none' };

export function decideLifecycle(signal: LifecycleSignal, context: LifecycleContext): LifecycleAction[] {
  switch (signal) {
    case 'renderer-process-gone':
      // The renderer is presentation; the main process and runtime keep working.
      return [
        { type: 'keep-runtime', reason: 'renderer_crashed' },
        { type: 'recreate-window', reason: 'renderer_crashed' },
      ];
    case 'window-closed':
      return [
        { type: 'keep-runtime', reason: 'window_closed' },
        ...(context.closeToTray ? ([{ type: 'hide-to-tray', reason: 'window_closed' }] as const) : []),
      ];
    case 'app-before-quit':
      if (!context.runtimeOwned || !context.runtimeAlive) return [{ type: 'none' }];
      return [
        ...(context.hasActiveWork ? ([{ type: 'interrupt-active-turn', reason: 'quit_and_stop' }] as const) : []),
        { type: 'stop-owned-runtime', reason: 'quit_and_stop' },
      ];
    case 'app-will-quit':
      return [{ type: 'none' }];
    case 'runtime-exited-expected':
      return [{ type: 'none' }];
    case 'runtime-exited-unexpected':
      return [
        { type: 'mark-runtime-crashed', restart: 'bounded' },
        ...(context.hasActiveWork ? [{ type: 'mark-outcome-unknown', reason: 'runtime_crashed' } as const] : []),
      ];
    case 'forced-termination-detected':
      return [
        { type: 'mark-outcome-unknown', reason: 'forced_termination' },
        ...(context.runtimeOwned && context.runtimeAlive
          ? ([{ type: 'stop-owned-runtime', reason: 'forced_termination' }] as const)
          : []),
      ];
    case 'machine-restart-detected':
      return context.staleOwnershipRecords > 0
        ? [{ type: 'reconcile-stale-ownership', count: context.staleOwnershipRecords }]
        : [{ type: 'none' }];
    case 'second-instance':
      return [{ type: 'focus-existing-window' }, { type: 'queue-launch-path' }];
    default: {
      const exhaustive: never = signal;
      return exhaustive;
    }
  }
}

/**
 * Parse a launcher invocation into absolute folder paths, ignoring Electron
 * switches. Kept as the path-only view of the documented launcher contract in
 * `cli.ts`; new code should use `parseLaunchCommand` for the full command.
 */
export function parseLaunchArgs(argv: string[], cwd: string, platform: NodeJS.Platform = process.platform): string[] {
  const command = parseLaunchCommand(argv.slice(1), cwd, platform);
  return command.kind === 'launch' ? command.paths : [];
}
