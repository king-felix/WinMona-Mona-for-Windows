import { errorResult } from '@mona/contracts';
import { z } from 'zod';
import { LAUNCH_CHANNELS, type LaunchStateView } from '../shared/launch.js';
import type { IpcHandle } from './ipc.js';

const Empty = z.object({}).strict();

/**
 * The launcher snapshot. Explorer starts Mona in the main process, so the
 * renderer only needs to read the latest receipt and subscribe to new ones; it
 * never receives a path to execute.
 */
export function registerLaunchIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  state: () => LaunchStateView;
}): string[] {
  deps.handle(LAUNCH_CHANNELS.state, (event, payload) => {
    if (!deps.isTrustedSender(event)) {
      return { ok: false, error: errorResult('untrusted_sender', 'IPC sender is not the Mona application frame.') };
    }
    const parsed = Empty.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: errorResult('invalid_request', 'launch-state accepts an empty object only.') };
    }
    try {
      return { ok: true, data: deps.state() };
    } catch {
      return { ok: false, error: errorResult('internal', 'Could not read the launch state.', true) };
    }
  });
  return [LAUNCH_CHANNELS.state];
}
