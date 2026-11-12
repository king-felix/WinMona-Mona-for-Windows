import { errorResult } from '@mona/contracts';
import { z } from 'zod';
import { ATTENTION_CHANNELS, type AttentionView } from '../shared/attention.js';
import type { IpcResult } from '../shared/catalog.js';
import type { IpcHandle } from './ipc.js';

const QuietPatch = z
  .object({
    enabled: z.boolean().optional(),
    startMinute: z.number().int().min(0).max(1439).optional(),
    endMinute: z.number().int().min(0).max(1439).optional(),
    timeZone: z.string().min(1).max(80).optional(),
  })
  .strict();

const SetRequest = z
  .object({
    notificationsEnabled: z.boolean().optional(),
    density: z.enum(['comfortable', 'compact']).optional(),
    firstCloseNotified: z.boolean().optional(),
    quietHours: QuietPatch.optional(),
  })
  .strict();

const Empty = z.object({}).strict();

/**
 * Attention settings and the one privileged action the renderer may request:
 * quit and stop owned work. Quiet hours are policy, not computation: changing
 * them never starts or stops a turn.
 */
export function registerAttentionIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  view: () => AttentionView;
  update: (patch: z.infer<typeof SetRequest>) => AttentionView;
  quitAndStop: () => void;
}): string[] {
  const channels: string[] = [];
  const guard = (event: unknown): IpcResult<never> | null =>
    deps.isTrustedSender(event)
      ? null
      : { ok: false, error: errorResult('untrusted_sender', 'IPC sender is not the Mona application frame.') };

  deps.handle(ATTENTION_CHANNELS.get, (event, payload) => {
    const denied = guard(event);
    if (denied) return denied;
    if (!Empty.safeParse(payload).success) {
      return { ok: false, error: errorResult('invalid_request', 'attention-get accepts an empty object only.') };
    }
    try {
      return { ok: true, data: deps.view() };
    } catch {
      return { ok: false, error: errorResult('internal', 'Attention state could not be read.', true) };
    }
  });
  channels.push(ATTENTION_CHANNELS.get);

  deps.handle(ATTENTION_CHANNELS.set, (event, payload) => {
    const denied = guard(event);
    if (denied) return denied;
    const parsed = SetRequest.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: errorResult('invalid_request', 'attention-set received an invalid request.') };
    }
    try {
      return { ok: true, data: deps.update(parsed.data) };
    } catch (error) {
      return {
        ok: false,
        error: errorResult('invalid_request', String((error as Error).message).slice(0, 300)),
      };
    }
  });
  channels.push(ATTENTION_CHANNELS.set);

  deps.handle(ATTENTION_CHANNELS.quitStop, (event, payload) => {
    const denied = guard(event);
    if (denied) return denied;
    if (!Empty.safeParse(payload).success) {
      return { ok: false, error: errorResult('invalid_request', 'attention-quit-stop accepts an empty object only.') };
    }
    deps.quitAndStop();
    return {
      ok: true,
      data: {
        requested: true,
        detail: 'Quit requested. Mona interrupts the active turn and stops owned runtimes before exiting.',
      },
    };
  });
  channels.push(ATTENTION_CHANNELS.quitStop);

  // The focus channel is main → renderer; it is listed here so the expected
  // preload channel set stays visible in one place.
  channels.push(ATTENTION_CHANNELS.focus);
  return channels;
}
