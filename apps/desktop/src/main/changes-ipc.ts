import { errorResult } from '@mona/contracts';
import { z } from 'zod';
import type { IpcResult } from '../shared/catalog.js';
import { CHANGES_CHANNELS } from '../shared/changes.js';
import type { ChangesService } from './changes-service.js';
import type { IpcHandle } from './ipc.js';

const ProjectOnly = z.object({ projectId: z.string().min(1).max(80) }).strict();
const DiffRequest = z.object({ projectId: z.string().min(1).max(80), path: z.string().min(1).max(1_024) }).strict();
const CaptureRequest = z
  .object({ projectId: z.string().min(1).max(80), label: z.string().max(120).optional() })
  .strict();

type Handler = (payload: unknown, service: ChangesService) => IpcResult<unknown> | Promise<IpcResult<unknown>>;

/** The Changes surface. Sender first, payload second, then a read-only service. */
export function registerChangesIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  service: () => ChangesService | null;
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
          error: errorResult('internal', 'Local project state is unavailable. See Settings → Diagnostics.', true),
        };
      }
      try {
        return handler(parsed.data, service);
      } catch {
        return { ok: false, error: errorResult('internal', 'The change request failed.') };
      }
    });
  };

  register(CHANGES_CHANNELS.view, ProjectOnly, (payload, service) =>
    service.view((payload as { projectId: string }).projectId),
  );
  register(CHANGES_CHANNELS.diff, DiffRequest, (payload, service) => {
    const input = payload as { projectId: string; path: string };
    return service.diff(input.projectId, input.path);
  });
  register(CHANGES_CHANNELS.capture, CaptureRequest, (payload, service) => {
    const input = payload as { projectId: string; label?: string };
    return service.capture(input.projectId, input.label);
  });

  return channels;
}
