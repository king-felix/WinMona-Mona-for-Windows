import { errorResult } from '@mona/contracts';
import { z } from 'zod';
import { COMMAND_CHANNELS } from '../shared/commands.js';
import type { CommandService } from './command-service.js';
import type { IpcHandle } from './ipc.js';

/**
 * The command surface: one channel, one typed operation set. The payload is
 * validated here before the service sees it; the service re-parses the command
 * text itself, so a compromised renderer cannot reach an operation by claiming
 * the text was something else.
 */
const DispatchRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    sessionId: z.string().min(1).max(120),
    text: z.string().min(1).max(1_000),
    operationKey: z
      .string()
      .min(8)
      .max(120)
      .regex(/^[A-Za-z0-9_.:-]+$/),
  })
  .strict();

export function registerCommandIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  service: () => CommandService | null;
}): string[] {
  const channels: string[] = [];
  const register = (
    channel: string,
    schema: z.ZodType,
    handler: (
      payload: z.infer<typeof DispatchRequest>,
      service: CommandService,
    ) => ReturnType<CommandService['dispatch']>,
  ): void => {
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
          error: errorResult('internal', 'Local project state is unavailable. See Settings → Diagnostics.', true),
        };
      }
      try {
        return handler(parsed.data as z.infer<typeof DispatchRequest>, service);
      } catch {
        return { ok: false, error: errorResult('internal', 'The command did not complete.', true) };
      }
    });
  };

  register(COMMAND_CHANNELS.dispatch, DispatchRequest, (payload, service) => service.dispatch(payload));

  return channels;
}
