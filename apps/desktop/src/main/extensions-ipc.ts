import { errorResult } from '@mona/contracts';
import { z } from 'zod';
import { EXTENSION_CHANNELS } from '../shared/extensions.js';
import type { IpcResult } from '../shared/catalog.js';
import type { IpcHandle } from './ipc.js';
import type { ExtensionsService } from './extensions-service.js';

const ViewRequest = z.object({ projectId: z.string().min(1).max(80) }).strict();
const SetRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    name: z.string().min(1).max(200),
    enabled: z.boolean(),
    expectedRevision: z.string().min(1).max(200),
  })
  .strict();
const CheckRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    name: z.string().min(1).max(200),
    expectedRevision: z.string().min(1).max(200),
  })
  .strict();

type Handler = (payload: unknown, service: ExtensionsService) => IpcResult<unknown> | Promise<IpcResult<unknown>>;

export function registerExtensionIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  service: () => ExtensionsService | null;
}): string[] {
  const channels: string[] = [];
  const register = (channel: string, schema: z.ZodType, handler: Handler): void => {
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
          error: errorResult('internal', 'Extensions are available only inside the running app.', true),
        };
      }
      try {
        return handler(parsed.data, service);
      } catch {
        return { ok: false, error: errorResult('internal', 'The extension action failed.', true) };
      }
    });
  };
  register(EXTENSION_CHANNELS.get, ViewRequest, (payload, service) => service.view(payload as { projectId: string }));
  register(EXTENSION_CHANNELS.setMcp, SetRequest, (payload, service) =>
    service.setMcpEnabled(payload as { projectId: string; name: string; enabled: boolean; expectedRevision: string }),
  );
  register(EXTENSION_CHANNELS.checkMcp, CheckRequest, (payload, service) =>
    service.checkMcpHealth(payload as { projectId: string; name: string; expectedRevision: string }),
  );
  return channels;
}
