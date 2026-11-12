import { errorResult } from '@mona/contracts';
import { z } from 'zod';
import { PROVIDER_CHANNELS } from '../shared/provider.js';
import type { IpcResult } from '../shared/catalog.js';
import type { IpcHandle } from './ipc.js';
import type { ProviderWorkbenchService } from './provider-workbench.js';

const ViewRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    sessionId: z.string().min(1).max(120),
    providerId: z.string().min(1).max(200).optional(),
  })
  .strict();
const RouteRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    sessionId: z.string().min(1).max(120),
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(300),
    expectedRevision: z.string().min(1).max(128),
  })
  .strict();
const PermissionRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    sessionId: z.string().min(1).max(120),
    posture: z.enum(['ask', 'auto-review', 'full-access']),
    expectedRevision: z.string().min(1).max(128),
  })
  .strict();
const ModeRequest = z
  .object({
    projectId: z.string().min(1).max(80),
    sessionId: z.string().min(1).max(120),
    mode: z.enum(['agent', 'plan']),
    expectedRevision: z.string().min(1).max(128),
  })
  .strict();

type Handler = (
  payload: unknown,
  service: ProviderWorkbenchService,
) => IpcResult<unknown> | Promise<IpcResult<unknown>>;

export function registerProviderIpc(deps: {
  handle: IpcHandle;
  isTrustedSender: (event: unknown) => boolean;
  service: () => ProviderWorkbenchService | null;
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
          error: errorResult('internal', 'The provider workbench is available only inside the running app.', true),
        };
      }
      try {
        return handler(parsed.data, service);
      } catch {
        return { ok: false, error: errorResult('internal', 'The configuration action failed.', true) };
      }
    });
  };
  register(PROVIDER_CHANNELS.get, ViewRequest, (payload, service) =>
    service.view(payload as { projectId: string; sessionId: string; providerId?: string }),
  );
  register(PROVIDER_CHANNELS.applyRoute, RouteRequest, (payload, service) =>
    service.applyRoute(
      payload as {
        projectId: string;
        sessionId: string;
        provider: string;
        model: string;
        expectedRevision: string;
      },
    ),
  );
  register(PROVIDER_CHANNELS.applyPermission, PermissionRequest, (payload, service) =>
    service.applyPermission(
      payload as {
        projectId: string;
        sessionId: string;
        posture: 'ask' | 'auto-review' | 'full-access';
        expectedRevision: string;
      },
    ),
  );
  register(PROVIDER_CHANNELS.applyMode, ModeRequest, (payload, service) =>
    service.applyMode(
      payload as { projectId: string; sessionId: string; mode: 'agent' | 'plan'; expectedRevision: string },
    ),
  );
  return channels;
}
