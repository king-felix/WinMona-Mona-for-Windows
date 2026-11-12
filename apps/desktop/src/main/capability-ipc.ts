import { errorResult } from '@mona/contracts';
import { z } from 'zod';
import { CAPABILITY_CHANNELS } from '../shared/capabilities.js';
import type { IpcResult } from '../shared/catalog.js';
import type { IpcHandle } from './ipc.js';
import type { CapabilityService } from './capability-service.js';

const EmptyRequest = z.object({}).strict();
const LogRequest = z
  .object({
    name: z
      .string()
      .min(1)
      .max(300)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'log name must be a single file name')
      .refine((value) => value !== '.' && value !== '..', 'log name must be a file name'),
    offset: z.number().int().nonnegative().optional(),
    limit: z
      .number()
      .int()
      .positive()
      .max(64 * 1024)
      .optional(),
  })
  .strict();

type Handler = (payload: unknown, service: CapabilityService) => IpcResult<unknown> | Promise<IpcResult<unknown>>;

export function registerCapabilityIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  service: () => CapabilityService | null;
}): string[] {
  const channels: string[] = [];
  const register = (channel: string, schema: z.ZodType, handler: Handler): void => {
    channels.push(channel);
    deps.handle(channel, (event, payload) => {
      if (!deps.isTrustedSender(event)) {
        return { ok: false, error: errorResult('untrusted_sender', 'IPC sender is not the Mona application frame.') };
      }
      const parsed = schema.safeParse(payload ?? {});
      if (!parsed.success) {
        return { ok: false, error: errorResult('invalid_request', `${channel} received an invalid request.`) };
      }
      const service = deps.service();
      if (!service) {
        return {
          ok: false,
          error: errorResult('internal', 'The capability explorer is available only inside the running app.', true),
        };
      }
      try {
        return handler(parsed.data, service);
      } catch {
        return { ok: false, error: errorResult('internal', 'The capability action failed.', true) };
      }
    });
  };
  register(CAPABILITY_CHANNELS.get, EmptyRequest, (_payload, service) => service.view());
  register(CAPABILITY_CHANNELS.readLog, LogRequest, (payload, service) =>
    service.readLog(payload as { name: string; offset?: number; limit?: number }),
  );
  register(CAPABILITY_CHANNELS.checkTerminal, EmptyRequest, (_payload, service) => service.checkTerminal());
  return channels;
}
