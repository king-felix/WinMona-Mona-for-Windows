import { errorResult } from '@mona/contracts';
import { z } from 'zod';
import { APPEARANCE_CHANNELS, type AppearanceView } from '../shared/appearance.js';
import type { IpcResult } from '../shared/catalog.js';
import type { IpcHandle } from './ipc.js';

const Empty = z.object({}).strict();

// A direction, not a number: the renderer cannot ask for an arbitrary scale.
const ZoomRequest = z
  .object({
    direction: z.enum(['in', 'out', 'reset']),
  })
  .strict();

/**
 * Window scale. This is the only appearance action the renderer may request, and
 * it is a pure presentation change: it steps a fixed ladder and persists the
 * choice. It never touches the engine, a workspace, or any recorded data.
 */
export function registerAppearanceIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  view: () => AppearanceView;
  zoom: (direction: 'in' | 'out' | 'reset') => AppearanceView;
}): string[] {
  const channels: string[] = [];
  const guard = (event: unknown): IpcResult<never> | null =>
    deps.isTrustedSender(event)
      ? null
      : { ok: false, error: errorResult('untrusted_sender', 'IPC sender is not the Mona application frame.') };

  deps.handle(APPEARANCE_CHANNELS.get, (event, payload) => {
    const denied = guard(event);
    if (denied) return denied;
    if (!Empty.safeParse(payload).success) {
      return { ok: false, error: errorResult('invalid_request', 'appearance-get accepts an empty object only.') };
    }
    try {
      return { ok: true, data: deps.view() };
    } catch {
      return { ok: false, error: errorResult('internal', 'The window scale could not be read.', true) };
    }
  });
  channels.push(APPEARANCE_CHANNELS.get);

  deps.handle(APPEARANCE_CHANNELS.zoom, (event, payload) => {
    const denied = guard(event);
    if (denied) return denied;
    const parsed = ZoomRequest.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: errorResult('invalid_request', 'appearance-zoom accepts a direction only.') };
    }
    try {
      return { ok: true, data: deps.zoom(parsed.data.direction) };
    } catch {
      return { ok: false, error: errorResult('internal', 'The window scale could not be changed.', true) };
    }
  });
  channels.push(APPEARANCE_CHANNELS.zoom);

  // Push-only: the main process reports a keyboard-driven change. Listed here so
  // the expected channel surface stays visible in one place.
  channels.push(APPEARANCE_CHANNELS.event);
  return channels;
}
